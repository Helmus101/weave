import { ipcMain, BrowserWindow } from "electron";
import { z } from "zod";
import { IPC } from "../shared/ipc";

const CHAT_THINKING_CHANNEL = IPC.chatThinkingStep;
const CHAT_MESSAGE_CHANNEL = IPC.chatMessageReceived;
const CAPTURE_STATE_CHANNEL = IPC.captureStateChanged;
const PROACTIVE_SUGGESTIONS_CHANNEL = IPC.proactiveSuggestions;
const PROACTIVE_GENERATION_STATE_CHANNEL = IPC.proactiveGenerationState;

import type { MemoryLayer } from "../shared/types";
import type { WeaveDatabase } from "./db/client";
import type { WatcherService } from "./services/watcher";
import type { DeepSeekService } from "./services/deepseek";
import type { VectorStore } from "./services/vectorStore";
import type { SettingsService } from "./services/settings";
import type { GoogleService } from "./services/google";
import type { RetrievalService } from "./services/retrieval";
import type { IntelligenceEngine } from "./services/intelligence";
import type { ProactiveService } from "./services/proactive";
import type { AppleContactService } from "./services/appleContacts";
import type { RoutineService } from "./services/routines";

interface IpcServices {
  db: WeaveDatabase;
  watcher: WatcherService;
  deepseek: DeepSeekService;
  vectors: VectorStore;
  settings: SettingsService;
  google: GoogleService;
  retrieval: RetrievalService;
  intelligence: IntelligenceEngine;
  proactive: ProactiveService;
  appleContacts: AppleContactService;
  routines: RoutineService;
}

const settingsUpdateSchema = z.object({
  rawCloudAllowed: z.boolean().optional(),
  publicMcpUrl: z.string().url().optional().or(z.literal("")),
  blacklistedApps: z.array(z.string()).optional(),
  blacklistedWebsites: z.array(z.string()).optional(),
  externalContactResearchAllowed: z.boolean().optional(),
  quickChatShortcut: z.string().min(1).optional(),
  deepseekApiKey: z.string().optional()
}).strict();

const memoryMetadataUpdateSchema = z.record(z.any());

const proactiveSuggestionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  summary: z.string(),
  plan: z.string(),
  immediateTasks: z.array(z.string()),
  createdAt: z.string()
}).passthrough();

const routineSourcesSchema = z.object({
  memory: z.boolean(),
  calendar: z.boolean(),
  contacts: z.boolean(),
  web: z.boolean()
});

const routineSaveSchema = z.object({
  id: z.string().optional(),
  templateId: z.string().optional(),
  kind: z.enum(["template", "custom"]).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  prompt: z.string().min(1).optional(),
  cadence: z.enum(["manual", "daily", "weekdays", "weekly"]).optional(),
  enabled: z.boolean().optional(),
  timeOfDay: z.string().optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  sources: routineSourcesSchema.optional(),
  tone: z.string().optional(),
  lastRunAt: z.string().optional()
}).strict();

const googleTokensSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiryDate: z.number().optional()
});

const authSessionSchema = z.object({
  authUrl: z.string().url(),
  callbackUrlPrefix: z.string().url()
});

export function registerIpc(services: IpcServices, options?: { onSettingsChanged?: () => { ok: boolean; error?: string } }) {
  const handle = (channel: string, callback: any) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, callback);
  };

  handle(IPC.appStatus, () => ({
    ready: true as const,
    activeAccountId: services.settings.activeAccountId || "default"
  }));

  handle(IPC.captureState, () => services.watcher.getState());
  handle(IPC.captureSetEnabled, (_event: any, enabled: boolean) => services.watcher.setEnabled(enabled));
  handle(IPC.captureRunNow, () => services.watcher.runNow());

  handle(IPC.search, async (_event: any, query: string) => {
    return services.retrieval.search(query);
  });

  handle(IPC.chatSessionCreate, (_event: any, title?: string) => {
    return services.db.createChatSession(title || "New Chat");
  });
  handle(IPC.chatSessionsGet, () => services.db.getChatSessions());
  handle(IPC.chatMessagesGet, (_event: any, sessionId: string) => {
    return services.db.getChatMessages(sessionId);
  });
  handle(IPC.chatDeleteSession, (_event: any, id: string) => {
    services.db.deleteChatSession(id);
  });
  handle(IPC.chatMessageSend, async (_event: any, sessionId: string, content: string) => {
    try {
      const response = await services.intelligence.processChat(sessionId, content, (step) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(CHAT_THINKING_CHANNEL, step);
        }
      });
      const messages = services.db.getChatMessages(sessionId);
      const lastMessage = messages[messages.length - 1];
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(CHAT_MESSAGE_CHANNEL, lastMessage);
      }
      return response;
    } catch (error) {
      console.error("[IPC] Chat processing failed:", error);
      services.db.addChatMessage(
        sessionId,
        "assistant",
        "The chat pipeline failed before a full answer could be generated. The request was not dropped, but response generation needs attention."
      );
      const messages = services.db.getChatMessages(sessionId);
      const lastMessage = messages[messages.length - 1];
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(CHAT_MESSAGE_CHANNEL, lastMessage);
      }
      return lastMessage?.content || "";
    }
  });

  handle(IPC.proactiveSuggestions, () => {
    return services.db.kvGet("proactive_suggestions") || [];
  });
  handle(IPC.proactiveSuggestionsGenerate, async () => {
    return services.proactive.generateSuggestions();
  });
  handle(IPC.proactiveTaskDetail, async (_event: any, summary: string, plan?: string, evidence?: string) => {
    return services.proactive.getTaskDetail(summary, plan, evidence);
  });
  handle(IPC.proactiveSuggestionsSet, (_event: any, suggestions: any[]) => {
    const next = z.array(proactiveSuggestionSchema).parse(Array.isArray(suggestions) ? suggestions : []);
    services.db.kvSet("proactive_suggestions", next, "json");
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(PROACTIVE_SUGGESTIONS_CHANNEL, next);
    }
    return next;
  });

  handle(IPC.routinesTemplatesGet, () => services.routines.getTemplates());
  handle(IPC.routinesGet, () => services.routines.getRoutines());
  handle(IPC.routinesSave, (_event: any, routine: any) => services.routines.saveRoutine(routineSaveSchema.parse(routine)));
  handle(IPC.routinesDelete, (_event: any, id: string) => {
    services.routines.deleteRoutine(id);
  });
  handle(IPC.routinesRunNow, async (_event: any, id: string) => services.routines.runRoutineNow(String(id || "")));
  handle(IPC.routinesRunsGet, (_event: any, routineId?: string) => services.routines.getRuns(routineId));
  handle(IPC.routinesRunGet, (_event: any, id: string) => services.routines.getRun(String(id || "")));

  handle(IPC.memoryNodesGet, (_event: any, layer?: MemoryLayer) => {
    return services.db.getMemoryNodes(layer);
  });
  handle(IPC.memoryNodeDetails, (_event: any, id: string) => {
    const node = services.db.getMemoryNode(id);
    const edges = services.db.getMemoryEdges(id);
    return { node, edges };
  });
  handle(IPC.memoryUpdateMetadata, (_event: any, id: string, metadata: any) => {
    services.db.updateMemoryNodeMetadata(id, memoryMetadataUpdateSchema.parse(metadata));
  });
  handle(IPC.memorySynthesizeEpisodes, () => services.watcher.synthesizeNow());

  handle(IPC.settingsGet, async () => ({
    ...services.settings.snapshot(),
    googleConnected: (await services.google.status()).connected,
    subsystemHealth: services.db.getSubsystemHealth()
  }));
  handle(IPC.settingsDeleteAllData, async () => {
    services.db.deleteAllData();
    await services.vectors.clearAll();
    await services.google.clearCredentials();
  });
  handle(IPC.settingsUpdate, async (_event: any, updates: any) => {
    const parsed = settingsUpdateSchema.parse(updates);
    let shouldNotifySettingsChange = false;
    if (typeof parsed.rawCloudAllowed === "boolean") {
      services.settings.setRawCloudAllowed(parsed.rawCloudAllowed);
      shouldNotifySettingsChange = true;
    }
    if (typeof parsed.publicMcpUrl === "string") {
      services.settings.setPublicMcpUrl(parsed.publicMcpUrl);
      shouldNotifySettingsChange = true;
    }
    if (parsed.blacklistedApps) services.settings.setBlacklistedApps(parsed.blacklistedApps);
    if (parsed.blacklistedWebsites) services.settings.setBlacklistedWebsites(parsed.blacklistedWebsites);
    if (typeof parsed.externalContactResearchAllowed === "boolean") {
      services.settings.setExternalContactResearchAllowed(parsed.externalContactResearchAllowed);
    }
    if (typeof parsed.quickChatShortcut === "string") {
      const previousShortcut = services.settings.quickChatShortcut;
      services.settings.setQuickChatShortcut(parsed.quickChatShortcut);
      const result = options?.onSettingsChanged?.();
      if (result && !result.ok) {
        services.settings.setQuickChatShortcut(previousShortcut);
        options?.onSettingsChanged?.();
        throw new Error(result.error || "Quick Chat shortcut could not be registered.");
      }
      shouldNotifySettingsChange = true;
    }
    if (typeof parsed.deepseekApiKey === "string") {
      services.settings.setDeepseekApiKey(parsed.deepseekApiKey);
    }
    if (shouldNotifySettingsChange) {
      options?.onSettingsChanged?.();
    }
    return {
      ...services.settings.snapshot(),
      googleConnected: (await services.google.status()).connected,
      subsystemHealth: services.db.getSubsystemHealth()
    };
  });

  handle(IPC.googleStatus, () => services.google.status());
  handle(IPC.googleStartAuth, () => services.google.startAuth());
  handle(IPC.googleFinishAuth, (_event: any, code: string) => services.google.finishAuth(z.string().min(1).parse(code)));
  handle(IPC.googleSetTokens, (_event: any, tokens: any) => services.google.setTokens(googleTokensSchema.parse(tokens)));
  handle(IPC.googleSync, () => services.google.sync());
  handle(IPC.authOpenSession, async (_event: any, authUrl: string, callbackUrlPrefix: string) => {
    const parsed = authSessionSchema.parse({ authUrl, callbackUrlPrefix });
    return openAuthSession(parsed.authUrl, parsed.callbackUrlPrefix);
  });

  handle(IPC.appleContactsSync, () => services.appleContacts.sync());

  handle(IPC.openScreenshotsFolder, async () => {
    return { ok: false, path: "", error: "Screenshots are not persisted to disk. Only OCR text is saved." };
  });

  const broadcastCaptureState = (state: any) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(CAPTURE_STATE_CHANNEL, state);
    }
  };

  const broadcastNudge = (nudge: any) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("proactive-nudge", nudge);
    }
  };

  const broadcastSuggestions = (suggestions: any) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(PROACTIVE_SUGGESTIONS_CHANNEL, suggestions);
    }
  };

  const broadcastGenState = (state: any) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(PROACTIVE_GENERATION_STATE_CHANNEL, state);
    }
  };

  let removeBindings = () => {};
  const rebindRuntimeListeners = () => {
    removeBindings();
    const boundWatcher = services.watcher;
    const boundProactive = services.proactive;
    boundWatcher.on("state", broadcastCaptureState);
    boundWatcher.on("nudge", broadcastNudge);
    boundProactive.on("suggestions", broadcastSuggestions);
    boundProactive.on("generationState", broadcastGenState);
    removeBindings = () => {
      boundWatcher.off("state", broadcastCaptureState);
      boundWatcher.off("nudge", broadcastNudge);
      boundProactive.off("suggestions", broadcastSuggestions);
      boundProactive.off("generationState", broadcastGenState);
    };
  };

  rebindRuntimeListeners();
  return rebindRuntimeListeners;
}

async function openAuthSession(authUrl: string, callbackUrlPrefix: string): Promise<{ callbackUrl: string }> {
  const parent = BrowserWindow.getAllWindows()[0];
  const authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    show: true,
    parent,
    modal: !!parent,
    autoHideMenuBar: true,
    backgroundColor: "#f6f1e8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void authWindow.loadURL(url);
    }
    return { action: "deny" };
  });

  return new Promise<{ callbackUrl: string }>((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      authWindow.webContents.removeListener("will-redirect", handleNavigation);
      authWindow.webContents.removeListener("will-navigate", handleNavigation);
      authWindow.webContents.removeListener("did-navigate", handleDidNavigate);
      authWindow.removeListener("closed", handleClosed);
    };

    const finish = (callbackUrl: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (!authWindow.isDestroyed()) authWindow.close();
      resolve({ callbackUrl });
    };

    const fail = (message: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (!authWindow.isDestroyed()) authWindow.close();
      reject(new Error(message));
    };

    const maybeFinish = (url: string) => {
      if (url.startsWith(callbackUrlPrefix)) {
        finish(url);
        return true;
      }
      return false;
    };

    const handleNavigation = (event: Electron.Event, url: string) => {
      if (maybeFinish(url)) {
        event.preventDefault();
      }
    };

    const handleDidNavigate = (_event: Electron.Event, url: string) => {
      maybeFinish(url);
    };

    const handleClosed = () => {
      fail("Authentication window was closed before sign-in completed.");
    };

    authWindow.webContents.on("will-redirect", handleNavigation);
    authWindow.webContents.on("will-navigate", handleNavigation);
    authWindow.webContents.on("did-navigate", handleDidNavigate);
    authWindow.on("closed", handleClosed);

    void authWindow.loadURL(authUrl).catch((error) => {
      fail(error instanceof Error ? error.message : "Failed to open authentication window.");
    });
  });
}
