import fs from "node:fs";
import path from "node:path";

function parseEnvFile(envPath: string) {
  if (!fs.existsSync(envPath)) return false;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

export function loadDotEnv(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(process.resourcesPath || "", ".env")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (parseEnvFile(candidate)) return;
  }
}
