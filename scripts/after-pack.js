const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

exports.default = async function(context) {
  console.log("🧹 Cleaning all extended attributes...");
  
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productName}.app`);
  const executableTargets = [
    path.join(appPath, "Contents", "Resources", "native", "ocr", "weave-ocr"),
    path.join(appPath, "Contents", "Resources", "native", "contacts", "fetch_apple_contacts")
  ];
  
  try {
    execSync(`xattr -cr "${appPath}"`, { stdio: "pipe" });
    execSync(`xattr -rd com.apple.quarantine "${appPath}" 2>/dev/null || true`, { stdio: "pipe" });
    execSync(`find "${appPath}" -exec xattr -d com.apple.FinderInfo {} \\; 2>/dev/null || true`, { stdio: "pipe" });
    execSync(`find "${appPath}" -exec xattr -d com.apple.ResourceFork {} \\; 2>/dev/null || true`, { stdio: "pipe" });
    execSync(`dot_clean -m "${appPath}" 2>/dev/null || true`, { stdio: "pipe" });
    
    console.log("✅ All extended attributes removed");
    
    // Verify no attributes remain
    try {
      const remaining = execSync(`xattr -r "${appPath}" 2>&1 | wc -l`).toString().trim();
      if (remaining === "0") {
        console.log("✅ Verified: no extended attributes");
      }
    } catch (e) {
      // ignore
    }

    for (const target of executableTargets) {
      if (fs.existsSync(target)) {
        fs.chmodSync(target, 0o755);
      }
    }
    console.log("✅ Native helpers marked executable");
  } catch (err) {
    console.warn("⚠️  Warning during cleanup:", err.message);
  }
};
