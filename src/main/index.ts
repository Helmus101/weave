import { app, BrowserWindow, Menu, Tray, nativeImage, powerMonitor, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { loadDotEnv } from "./config/env";
import { getAppPaths } from "./config/paths";
import { WeaveDatabase } from "./db/client";
import { SettingsService } from "./services/settings";
import { VectorStore } from "./services/vectorStore";
import { OcrBridge } from "./services/ocrBridge";
import { WatcherService } from "./services/watcher";
import { DeepSeekService } from "./services/deepseek";
import { GoogleService } from "./services/google";
import { RetrievalService } from "./services/retrieval";
import { IntelligenceEngine } from "./services/intelligence";
import { ProactiveService } from "./services/proactive";
import { ResearchService } from "./services/research";
import { IdentityService } from "./services/identity";
import { AppleContactService } from "./services/appleContacts";
import { registerIpc } from "./ipc";
import { IPC } from "../shared/ipc";

const SYNC_PROGRESS_CHANNEL = IPC.syncProgress;
const CHAT_THINKING_CHANNEL = IPC.chatThinkingStep;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;

loadDotEnv();

async function createWindow() {
  const preload = path.join(__dirname, "../../preload/preload/index.js");
  console.log("Preload path:", preload);
  console.log("Preload exists:", fs.existsSync(preload));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 640,
    title: "Weave",
    backgroundColor: "#f6f1e8",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

let currentServices: any = {
  db: null, watcher: null, deepseek: null, vectors: null, settings: null,
  google: null, retrieval: null, intelligence: null, proactive: null, appleContacts: null
};

async function bootstrap(userId?: string) {
  try {
    console.log(`[Main] Bootstrapping for user: ${userId || "default"}`);
    const paths = getAppPaths();
    
    // Account-specific DB path
    const dbFileName = userId ? `weave_${userId}.sqlite` : "weave.sqlite";
    const dbPath = path.join(path.dirname(paths.dbPath), dbFileName);
    
    if (currentServices.db) {
      console.log("[Main] Cleaning up existing services...");
      if (currentServices.watcher) currentServices.watcher.stop();
      if (currentServices.google?.syncTimer) clearInterval(currentServices.google.syncTimer);
      if (currentServices.db) currentServices.db.close();
    }

    const db = await WeaveDatabase.open(dbPath);
    const settings = new SettingsService(paths.userData);
    const vectors = new VectorStore(paths.vectorPath);
    await vectors.init();
    const ocr = new OcrBridge(paths.ocrBinaryPath);
    
    const deepseek = new DeepSeekService(() => settings.deepseekApiKey());
    const retrieval = new RetrievalService(db, vectors, deepseek);
    const intelligence = new IntelligenceEngine(db, retrieval, deepseek, vectors);
    const proactive = new ProactiveService(db, retrieval, intelligence);
    proactive.start();
    
    const watcher = new WatcherService(
      db,
      vectors,
      ocr,
      deepseek,
      () => settings.captureEnabled,
      (enabled) => settings.setCaptureEnabled(enabled),
      () => ({ apps: settings.blacklistedApps, websites: settings.blacklistedWebsites })
    );
    
    const research = new ResearchService(db, deepseek);
    research.startBackgroundRefresh();
    const identity = new IdentityService(db, research);
    
    const google = new GoogleService(db, () => settings.googleClient(), watcher, identity);
    const appleContacts = new AppleContactService(db, identity);
    
    // Initial Apple sync
    appleContacts.sync();
    
    const broadcastProgress = (progress: any) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(SYNC_PROGRESS_CHANNEL, progress);
      }
    };
    google.setProgressListener(broadcastProgress);
    appleContacts.setProgressListener(broadcastProgress);

    // Update the live references
    currentServices.db = db;
    currentServices.watcher = watcher;
    currentServices.deepseek = deepseek;
    currentServices.vectors = vectors;
    currentServices.settings = settings;
    currentServices.google = google;
    currentServices.retrieval = retrieval;
    currentServices.intelligence = intelligence;
    currentServices.proactive = proactive;
    currentServices.appleContacts = appleContacts;
    
    watcher.start();
    console.log("[Main] Bootstrap complete.");
    return currentServices;
  } catch (error) {
    console.error("Bootstrap error:", error);
    throw error;
  }
}

app.whenReady().then(async () => {
  await bootstrap();
  
  // Register IPC ONCE with the mutable services object
  registerIpc(currentServices);
  
  await createWindow();
  if (currentServices.watcher) createTray(currentServices.watcher);

  // Power Monitoring
  powerMonitor.on('suspend', () => currentServices.watcher?.setSystemPaused(true));
  powerMonitor.on('resume', () => currentServices.watcher?.setSystemPaused(false));
  powerMonitor.on('lock-screen', () => currentServices.watcher?.setSystemPaused(true));
  powerMonitor.on('unlock-screen', () => currentServices.watcher?.setSystemPaused(false));
});

// Switch account handler (lives outside to avoid re-registration issues)
ipcMain.handle(IPC.switchAccount, async (_event: any, userId: string) => {
  if (!userId) return { ok: false, error: "No user ID provided" };
  console.log(`[Main] IPC Switch Account Triggered: ${userId}`);
  try {
    await bootstrap(userId);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});


function createTray(watcher: WatcherService) {
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  const setMenu = () => {
    tray?.setToolTip("Weave");
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: "Show Weave", click: () => mainWindow?.show() },
      {
        label: watcher.getState().enabled ? "Pause Recording" : "Resume Recording",
        click: () => {
          watcher.setEnabled(!watcher.getState().enabled);
          setMenu();
        }
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ]));
  };
  setMenu();
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
