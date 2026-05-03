import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

export interface AppPaths {
  userData: string;
  dbPath: string;
  vectorPath: string;
  ocrBinaryPath: string;
  appleContactsBinaryPath: string;
}

export function getAppPaths(): AppPaths {
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const ocrBinaryPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "ocr", "weave-ocr")
    : path.join(process.cwd(), "native", "ocr", "weave-ocr");
  const appleContactsBinaryPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "contacts", "fetch_apple_contacts")
    : path.join(process.cwd(), "src", "main", "scripts", "fetch_apple_contacts");

  return {
    userData,
    dbPath: path.join(dataDir, "weave.sqlite"),
    vectorPath: path.join(dataDir, "vectors"),
    ocrBinaryPath,
    appleContactsBinaryPath
  };
}
