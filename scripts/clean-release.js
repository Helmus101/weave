const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const releaseDir = path.join(process.cwd(), "release");
const targets = [
  path.join(releaseDir, "mac"),
  path.join(releaseDir, "mac-arm64"),
  path.join(releaseDir, "builder-effective-config.yaml"),
  path.join(releaseDir, "Weave-0.1.0-arm64.dmg"),
  path.join(releaseDir, "Weave-0.1.0-arm64.dmg.blockmap"),
  path.join(releaseDir, "Weave-0.1.0-arm64-mac.zip"),
  path.join(releaseDir, "Weave-0.1.0-arm64-mac.zip.blockmap")
];

try {
  const hdiInfo = execSync("hdiutil info", { stdio: "pipe" }).toString();
  const attachedVolumes = [...hdiInfo.matchAll(/\/Volumes\/Weave[^\n]*/g)].map((match) => match[0].trim());
  for (const volume of attachedVolumes) {
    try {
      execSync(`hdiutil detach "${volume}" -force`, { stdio: "pipe" });
    } catch (error) {
      console.warn(`Failed to detach mounted volume ${volume}: ${error.message}`);
    }
  }
} catch (error) {
  console.warn(`Unable to inspect mounted disk images: ${error.message}`);
}

for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
