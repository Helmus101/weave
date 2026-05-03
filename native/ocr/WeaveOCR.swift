import AppKit
import Foundation
import Vision
import CoreGraphics

struct Bounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct TextBlock: Codable {
    let text: String
    let confidence: Double
    let bounds: Bounds
}

struct CaptureResponse: Codable {
    let ok: Bool
    let text: String
    let blocks: [TextBlock]
    let timestamp: String
    let activeApp: String?
    let activeBundleId: String?
    let activeWindowTitle: String?
    let permission: String
    let error: String?
    let screenshotPath: String?
}

func isoNow() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

func activeWindowTitle() -> String? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
    for window in windows {
        let owner = window[kCGWindowOwnerName as String] as? String
        let layer = window[kCGWindowLayer as String] as? Int
        if owner == app.localizedName && layer == 0 {
            return window[kCGWindowName as String] as? String
        }
    }
    return nil
}

func checkScreenPermission() -> String {
    if #available(macOS 10.15, *) {
        if CGPreflightScreenCaptureAccess() {
            return "granted"
        } else {
            CGRequestScreenCaptureAccess()
            return "denied"
        }
    }
    return "unknown"
}

func captureImage(savePath: String? = nil) -> (result: (CGImage, String?)?, error: String?) {
    let tempUrl = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("weave-ocr-\(UUID().uuidString).png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", tempUrl.path]
    let stderrPipe = Pipe()
    process.standardError = stderrPipe

    do {
        try process.run()
        process.waitUntilExit()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrText = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard process.terminationStatus == 0 else {
            let message = stderrText.isEmpty ? "screencapture exited with status \(process.terminationStatus)." : stderrText
            return (nil, message)
        }
        
        guard let image = NSImage(contentsOf: tempUrl),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            try? FileManager.default.removeItem(at: tempUrl)
            return (nil, "screencapture succeeded but the image could not be loaded.")
        }

        if let savePath = savePath {
            let finalUrl = URL(fileURLWithPath: savePath)
            try? FileManager.default.createDirectory(at: finalUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.moveItem(at: tempUrl, to: finalUrl)
            return ((cgImage, finalUrl.path), nil)
        } else {
            try? FileManager.default.removeItem(at: tempUrl)
            return ((cgImage, nil), nil)
        }
    } catch {
        return (nil, error.localizedDescription)
    }
}

func recognizeText(from image: CGImage) throws -> [TextBlock] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let blocks: [TextBlock] = observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return TextBlock(
            text: candidate.string,
            confidence: Double(candidate.confidence),
            bounds: Bounds(
                x: Double(box.origin.x),
                y: Double(box.origin.y),
                width: Double(box.size.width),
                height: Double(box.size.height)
            )
        )
    }
    return blocks.sorted { lhs, rhs in
        let lhsMidY = lhs.bounds.y + (lhs.bounds.height / 2.0)
        let rhsMidY = rhs.bounds.y + (rhs.bounds.height / 2.0)
        if abs(lhsMidY - rhsMidY) > 0.03 {
            return lhsMidY > rhsMidY
        }
        return lhs.bounds.x < rhs.bounds.x
    }
}

func emit(_ response: CaptureResponse) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode(response), let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"ok\":false,\"text\":\"\",\"blocks\":[],\"timestamp\":\"\(isoNow())\",\"permission\":\"unknown\",\"error\":\"Failed to encode OCR response\"}")
    }
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "capture"
let savePath = args.count > 2 ? args[2] : nil

guard command == "capture" || command == "permission" else {
    emit(CaptureResponse(ok: false, text: "", blocks: [], timestamp: isoNow(), activeApp: nil, activeBundleId: nil, activeWindowTitle: nil, permission: "unknown", error: "Unsupported command", screenshotPath: nil))
    exit(1)
}

let frontmost = NSWorkspace.shared.frontmostApplication
let permission = checkScreenPermission()

if command == "permission" {
    emit(CaptureResponse(
        ok: permission == "granted",
        text: "",
        blocks: [],
        timestamp: isoNow(),
        activeApp: frontmost?.localizedName,
        activeBundleId: frontmost?.bundleIdentifier,
        activeWindowTitle: activeWindowTitle(),
        permission: permission,
        error: permission == "granted" ? nil : "Permission not granted.",
        screenshotPath: nil
    ))
    exit(0)
}

guard permission == "granted" else {
    emit(CaptureResponse(
        ok: false,
        text: "",
        blocks: [],
        timestamp: isoNow(),
        activeApp: frontmost?.localizedName,
        activeBundleId: frontmost?.bundleIdentifier,
        activeWindowTitle: activeWindowTitle(),
        permission: permission,
        error: "Screen Recording permission is required.",
        screenshotPath: nil
    ))
    exit(0)
}

let captureResult = captureImage(savePath: savePath)
guard let (image, finalScreenshotPath) = captureResult.result else {
    let errorMessage = captureResult.error ?? "Unable to capture the screen."
    emit(CaptureResponse(
        ok: false,
        text: "",
        blocks: [],
        timestamp: isoNow(),
        activeApp: frontmost?.localizedName,
        activeBundleId: frontmost?.bundleIdentifier,
        activeWindowTitle: activeWindowTitle(),
        permission: permission,
        error: errorMessage,
        screenshotPath: nil
    ))
    exit(0)
}

do {
    let blocks = try recognizeText(from: image)
    emit(CaptureResponse(
        ok: true,
        text: blocks.map { $0.text }.joined(separator: "\n"),
        blocks: blocks,
        timestamp: isoNow(),
        activeApp: frontmost?.localizedName,
        activeBundleId: frontmost?.bundleIdentifier,
        activeWindowTitle: activeWindowTitle(),
        permission: permission,
        error: nil,
        screenshotPath: finalScreenshotPath
    ))
} catch {
    emit(CaptureResponse(
        ok: false,
        text: "",
        blocks: [],
        timestamp: isoNow(),
        activeApp: frontmost?.localizedName,
        activeBundleId: frontmost?.bundleIdentifier,
        activeWindowTitle: activeWindowTitle(),
        permission: permission,
        error: error.localizedDescription,
        screenshotPath: nil
    ))
}
