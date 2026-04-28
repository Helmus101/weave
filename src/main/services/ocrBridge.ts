import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

export interface OcrTextBlock {
  text: string;
  confidence: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface OcrCaptureResult {
  ok: boolean;
  text: string;
  blocks: OcrTextBlock[];
  timestamp: string;
  activeApp?: string;
  activeBundleId?: string;
  activeWindowTitle?: string;
  permission: "unknown" | "granted" | "denied";
  error?: string;
  screenshotPath?: string;
}

export class OcrBridge {
  constructor(private binaryPath: string) {}

  async capture(savePath?: string): Promise<OcrCaptureResult> {
    if (!fs.existsSync(this.binaryPath)) {
      return {
        ok: false,
        text: "",
        blocks: [],
        timestamp: new Date().toISOString(),
        permission: "unknown",
        error: `OCR bridge is not built. Run npm run build:ocr.`
      };
    }

    try {
      const args = ["capture"];
      if (savePath) args.push(savePath);
      
      const { stdout } = await execFileAsync(this.binaryPath, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
      return JSON.parse(stdout) as OcrCaptureResult;
    } catch (error) {
      return {
        ok: false,
        text: "",
        blocks: [],
        timestamp: new Date().toISOString(),
        permission: "unknown",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
