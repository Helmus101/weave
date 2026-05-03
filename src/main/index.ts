import { app, BrowserWindow, Menu, Tray, nativeImage, powerMonitor, ipcMain, shell, globalShortcut, screen, systemPreferences } from "electron";
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
import { GoogleTokenStore } from "./services/secureStorage";
import { RoutineService } from "./services/routines";
import { RemoteMcpService } from "./services/mcpRemote";
import { registerIpc } from "./ipc";
import { IPC } from "../shared/ipc";

const SYNC_PROGRESS_CHANNEL = IPC.syncProgress;
const QUICK_CHAT_COMPACT_SIZE = { width: 720, height: 116 };
const QUICK_CHAT_EXPANDED_SIZE = { width: 720, height: 640 };

interface ServiceContainer {
  db: WeaveDatabase | null;
  watcher: WatcherService | null;
  ocr: OcrBridge | null;
  deepseek: DeepSeekService | null;
  vectors: VectorStore | null;
  settings: SettingsService | null;
  google: GoogleService | null;
  retrieval: RetrievalService | null;
  intelligence: IntelligenceEngine | null;
  proactive: ProactiveService | null;
  appleContacts: AppleContactService | null;
  research: ResearchService | null;
  identity: IdentityService | null;
  tokenStore: GoogleTokenStore | null;
  routines: RoutineService | null;
}

let mainWindow: BrowserWindow | undefined;
let quickChatWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let remoteMcp: RemoteMcpService | undefined;
let rebindIpcRuntimeListeners: (() => void) | undefined;
const DEFAULT_QUICK_CHAT_SHORTCUT = "Alt+W";
const currentServices: ServiceContainer = {
  db: null,
  watcher: null,
  ocr: null,
  deepseek: null,
  vectors: null,
  settings: null,
  google: null,
  retrieval: null,
  intelligence: null,
  proactive: null,
  appleContacts: null,
  research: null,
  identity: null,
  tokenStore: null,
  routines: null
};

loadDotEnv();

function deriveScreenPermission() {
  const captureState = currentServices.watcher?.getState();
  const captureHealth = currentServices.db?.getSubsystemHealth().capture;
  const lastError = captureState?.lastError || captureHealth?.lastFailureMessage;
  if (captureState?.screenPermission && captureState.screenPermission !== "unknown") {
    return {
      status: captureState.screenPermission,
      lastVerifiedAt: captureState.lastCaptureAt || captureHealth?.lastSuccessAt,
      lastError
    };
  }
  if (captureHealth?.lastSuccessAt) {
    return {
      status: "granted" as const,
      lastVerifiedAt: captureHealth.lastSuccessAt,
      lastError
    };
  }
  const normalizedError = String(lastError || "").toLowerCase();
  if (
    normalizedError.includes("screen recording") ||
    normalizedError.includes("permission denied") ||
    normalizedError.includes("operation not permitted")
  ) {
    return {
      status: "denied" as const,
      lastVerifiedAt: captureHealth?.lastSuccessAt,
      lastError
    };
  }
  return {
    status: "unknown" as const,
    lastVerifiedAt: captureHealth?.lastSuccessAt,
    lastError
  };
}

async function probeScreenPermission() {
  if (!currentServices.ocr) {
    return {
      status: deriveScreenPermission().status,
      lastVerifiedAt: deriveScreenPermission().lastVerifiedAt,
      lastError: deriveScreenPermission().lastError
    };
  }
  const result = await currentServices.ocr.capture();
  currentServices.watcher?.recordProbeResult(result);
  if (result.ok) {
    return {
      status: "granted" as const,
      lastVerifiedAt: result.timestamp,
      lastError: undefined
    };
  }
  const normalizedError = String(result.error || "").toLowerCase();
  if (result.permission === "denied" || normalizedError.includes("permission denied") || normalizedError.includes("operation not permitted")) {
    return {
      status: "denied" as const,
      lastVerifiedAt: undefined,
      lastError: result.error
    };
  }
  return {
    status: "unknown" as const,
    lastVerifiedAt: undefined,
    lastError: result.error
  };
}

function deriveContactsPermission() {
  const contactsHealth = currentServices.db?.getSubsystemHealth().appleContacts;
  const lastError = contactsHealth?.lastFailureMessage;
  if (contactsHealth?.lastSuccessAt) {
    return {
      status: "granted" as const,
      lastVerifiedAt: contactsHealth.lastSuccessAt,
      lastError
    };
  }
  const normalizedError = String(lastError || "").toLowerCase();
  if (
    normalizedError.includes("contacts was denied") ||
    normalizedError.includes("operation not permitted") ||
    normalizedError.includes("permission denied")
  ) {
    return {
      status: "denied" as const,
      lastVerifiedAt: contactsHealth?.lastSuccessAt,
      lastError
    };
  }
  return {
    status: "unknown" as const,
    lastVerifiedAt: contactsHealth?.lastSuccessAt,
    lastError
  };
}

async function probeContactsPermission() {
  if (!currentServices.appleContacts) {
    return {
      status: deriveContactsPermission().status,
      lastVerifiedAt: deriveContactsPermission().lastVerifiedAt,
      lastError: deriveContactsPermission().lastError
    };
  }
  const status = await currentServices.appleContacts.getPermissionStatus();
  const derived = deriveContactsPermission();
  return {
    status,
    lastVerifiedAt: status === "granted" ? (derived.lastVerifiedAt || new Date().toISOString()) : derived.lastVerifiedAt,
    lastError: status === "unknown" ? derived.lastError : undefined
  };
}

function resolveTrayIconPath() {
  const packagedPath = path.join(process.resourcesPath, "assets", "icon-tray-template.svg");
  if (fs.existsSync(packagedPath)) return packagedPath;
  return path.join(app.getAppPath(), "assets", "icon-tray-template.svg");
}

function isAllowedNavigation(url: string) {
  if (url.startsWith("file://")) return true;
  if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) return true;
  return false;
}

function hardenWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
  });
}

async function createWindow() {
  const preload = path.join(__dirname, "../../preload/preload/index.js");
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
      sandbox: true
    }
  });

  hardenWindow(mainWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

async function createQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    if (quickChatWindow.isMinimized()) quickChatWindow.restore();
    setQuickChatWindowMode("compact");
    quickChatWindow.show();
    quickChatWindow.focus();
    return quickChatWindow;
  }

  const preload = path.join(__dirname, "../../preload/preload/index.js");
  quickChatWindow = new BrowserWindow({
    width: QUICK_CHAT_COMPACT_SIZE.width,
    height: QUICK_CHAT_COMPACT_SIZE.height,
    minWidth: QUICK_CHAT_COMPACT_SIZE.width,
    minHeight: QUICK_CHAT_COMPACT_SIZE.height,
    maxWidth: QUICK_CHAT_EXPANDED_SIZE.width,
    maxHeight: QUICK_CHAT_EXPANDED_SIZE.height,
    title: "Weave Quick Chat",
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    transparent: true,
    frame: false,
    titleBarStyle: "hidden",
    roundedCorners: true,
    hasShadow: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  hardenWindow(quickChatWindow);
  quickChatWindow.setAlwaysOnTop(true, "floating");
  quickChatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickChatWindow.on("closed", () => {
    quickChatWindow = undefined;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await quickChatWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?mode=quick-chat`);
  } else {
    await quickChatWindow.loadFile(path.join(__dirname, "../../renderer/index.html"), {
      query: { mode: "quick-chat" }
    });
  }

  setQuickChatWindowMode("compact");
  quickChatWindow.show();
  quickChatWindow.focus();
  return quickChatWindow;
}

function centerQuickChatWindow(window: BrowserWindow, width: number, height: number) {
  const bounds = window.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.max(workArea.y + 56, Math.round(workArea.y + workArea.height * 0.14));
  window.setBounds({ x, y, width, height }, true);
}

function setQuickChatWindowMode(mode: "compact" | "expanded") {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  const size = mode === "expanded" ? QUICK_CHAT_EXPANDED_SIZE : QUICK_CHAT_COMPACT_SIZE;
  centerQuickChatWindow(quickChatWindow, size.width, size.height);
}

function registerGlobalShortcuts() {
  // Shortcut registration disabled
  return { ok: true };
}

function syncRemoteMcpRuntime() {
  const services = currentServices;
  if (
    !remoteMcp ||
    !services.db ||
    !services.retrieval ||
    !services.intelligence ||
    !services.proactive ||
    !services.routines ||
    !services.settings
  ) {
    return;
  }

  const accountId = services.settings.activeAccountId || "default";
  const runtime = {
    accountId,
    db: services.db,
    retrieval: services.retrieval,
    intelligence: services.intelligence,
    proactive: services.proactive,
    routines: services.routines,
    settings: services.settings
  };
  remoteMcp.updateRuntime(runtime);
  if (services.settings.rawCloudAllowed && accountId !== "default") {
    void remoteMcp.start(runtime).catch((error) => {
      console.error("[Remote MCP] Failed to start:", error);
    });
  } else {
    void remoteMcp.stop().catch((error) => {
      console.error("[Remote MCP] Failed to stop:", error);
    });
  }
}

async function cleanupServices() {
  await remoteMcp?.stop();
  if (!currentServices.db) return;
  console.log("[Main] Cleaning up existing services...");
  currentServices.watcher?.stop();
  currentServices.google?.stop();
  currentServices.proactive?.stop();
  currentServices.research?.stop();
  currentServices.appleContacts?.stop();
  currentServices.identity?.stop();
  currentServices.routines?.stop();
  currentServices.db?.close();
}

async function bootstrap(userId?: string) {
  try {
    const paths = getAppPaths();
    const settings = new SettingsService(paths.userData);
    const accountNamespace = userId || settings.activeAccountId || "default";
    console.log(`[Main] Bootstrapping for user: ${accountNamespace}`);
    const effectiveDbFileName = accountNamespace === "default" ? "weave.sqlite" : `weave_${accountNamespace}.sqlite`;
    const effectiveDbPath = path.join(path.dirname(paths.dbPath), effectiveDbFileName);
    const vectorPath = path.join(paths.vectorPath, accountNamespace);
    await cleanupServices();

    const db = await WeaveDatabase.open(effectiveDbPath);
    const vectors = new VectorStore(vectorPath);
    await vectors.init();
    const ocr = new OcrBridge(paths.ocrBinaryPath);
    const tokenStore = new GoogleTokenStore(accountNamespace);

    const deepseek = new DeepSeekService(() => settings.deepseekApiKey());
    const retrieval = new RetrievalService(db, vectors, deepseek);
    const intelligence = new IntelligenceEngine(db, retrieval, deepseek, vectors);
    const proactive = new ProactiveService(db, retrieval, intelligence);
    const routines = new RoutineService(db, retrieval, intelligence);
    const watcher = new WatcherService(
      db,
      vectors,
      ocr,
      deepseek,
      () => settings.captureEnabled,
      (enabled) => settings.setCaptureEnabled(enabled),
      () => ({ apps: settings.blacklistedApps, websites: settings.blacklistedWebsites })
    );
    const research = new ResearchService(db, deepseek, () => settings.externalContactResearchAllowed);
    const identity = new IdentityService(db, research);
    const google = new GoogleService(db, () => settings.googleClient(), tokenStore, watcher, identity);
    const appleContacts = new AppleContactService(db, identity, paths.appleContactsBinaryPath);

    const broadcastProgress = (progress: any) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(SYNC_PROGRESS_CHANNEL, progress);
      }
    };
    google.setProgressListener(broadcastProgress);
    appleContacts.setProgressListener(broadcastProgress);

    proactive.start();
    routines.start();
    research.startBackgroundRefresh();
    watcher.start();
    void appleContacts.sync().catch((error) => {
      console.error("[Main] Apple Contacts startup sync failed:", error);
    });

    currentServices.db = db;
    currentServices.watcher = watcher;
    currentServices.ocr = ocr;
    currentServices.deepseek = deepseek;
    currentServices.vectors = vectors;
    currentServices.settings = settings;
    currentServices.google = google;
    currentServices.retrieval = retrieval;
    currentServices.intelligence = intelligence;
    currentServices.proactive = proactive;
    currentServices.appleContacts = appleContacts;
    currentServices.research = research;
    currentServices.identity = identity;
    currentServices.tokenStore = tokenStore;
    currentServices.routines = routines;
    settings.setActiveAccountId(accountNamespace);
    remoteMcp ??= new RemoteMcpService();
    syncRemoteMcpRuntime();
    if (app.isReady()) registerGlobalShortcuts();

    rebindIpcRuntimeListeners?.();
    if (tray) createTray(watcher);

    console.log("[Main] Bootstrap complete.");
    return currentServices;
  } catch (error) {
    console.error("Bootstrap error:", error);
    throw error;
  }
}

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

ipcMain.handle(IPC.quickChatSetMode, (_event: any, mode: "compact" | "expanded") => {
  setQuickChatWindowMode(mode === "expanded" ? "expanded" : "compact");
});

ipcMain.handle(IPC.quickChatClose, () => {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.close();
  }
});

ipcMain.handle(IPC.permissionsGet, async () => {
  const derivedScreenPermission = deriveScreenPermission();
  const screenPermission = derivedScreenPermission.status === "unknown"
    ? await probeScreenPermission()
    : derivedScreenPermission;
  const derivedContactsPermission = deriveContactsPermission();
  const contactsPermission = derivedContactsPermission.status === "unknown"
    ? await probeContactsPermission()
    : derivedContactsPermission;
  return {
    screen: screenPermission.status,
    screenLastVerifiedAt: screenPermission.lastVerifiedAt,
    screenLastError: screenPermission.lastError,
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    contacts: contactsPermission.status,
    contactsLastVerifiedAt: contactsPermission.lastVerifiedAt,
    contactsLastError: contactsPermission.lastError
  };
});

ipcMain.handle(IPC.permissionsOpen, (_event: any, pane: string) => {
  const urls: Record<string, string> = {
    screen:        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    contacts:      "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  };
  const url = urls[pane];
  if (url) void shell.openExternal(url);
});

function createTray(watcher: WatcherService) {
  tray?.destroy();
  const image = nativeImage.createFromPath(resolveTrayIconPath());
  if (!image.isEmpty() && process.platform === "darwin") {
    image.setTemplateImage(true);
  }
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

app.whenReady().then(async () => {
  await bootstrap();
  rebindIpcRuntimeListeners = registerIpc(currentServices as any, {
    onSettingsChanged: () => {
      const result = registerGlobalShortcuts();
      syncRemoteMcpRuntime();
      return result;
    }
  });
  await createWindow();
  registerGlobalShortcuts();
  if (currentServices.watcher) createTray(currentServices.watcher);

  powerMonitor.on("suspend", () => currentServices.watcher?.setSystemPaused(true));
  powerMonitor.on("resume", () => currentServices.watcher?.setSystemPaused(false));
  powerMonitor.on("lock-screen", () => currentServices.watcher?.setSystemPaused(true));
  powerMonitor.on("unlock-screen", () => currentServices.watcher?.setSystemPaused(false));
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
