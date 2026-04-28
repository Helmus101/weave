import { ipcMain, BrowserWindow } from "electron";
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
}

export function registerIpc(services: IpcServices) {
  // Helper to safely register or re-register handlers
  const handle = (channel: string, callback: any) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, callback);
  };

  handle(IPC.captureState, () => services.watcher.getState());
  handle(IPC.captureSetEnabled, (_event: any, enabled: boolean) => services.watcher.setEnabled(enabled));
  handle(IPC.captureRunNow, () => services.watcher.runNow());
  
  handle(IPC.search, async (_event: any, query: string) => {
    return services.retrieval.search(query);
  });


  // Chat
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

  handle(IPC.proactiveSuggestionsSet, (_event: any, suggestions: any[]) => {
    const next = Array.isArray(suggestions) ? suggestions : [];
    services.db.kvSet("proactive_suggestions", next, "json");
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(PROACTIVE_SUGGESTIONS_CHANNEL, next);
    }
    return next;
  });

  // Memory Explorer
  handle(IPC.memoryNodesGet, (_event: any, layer?: MemoryLayer) => {
    return services.db.getMemoryNodes(layer);
  });
  handle(IPC.memoryNodeDetails, (_event: any, id: string) => {
    const node = services.db.getMemoryNode(id);
    const edges = services.db.getMemoryEdges(id);
    return { node, edges };
  });
  handle(IPC.memoryUpdateMetadata, (_event: any, id: string, metadata: any) => {
    services.db.updateMemoryNodeMetadata(id, metadata);
  });
  handle(IPC.memorySynthesizeEpisodes, () => services.watcher.synthesizeNow());

  handle(IPC.settingsGet, () => ({
    ...services.settings.snapshot(),
    googleConnected: services.google.status().connected
  }));
  handle(IPC.settingsDeleteAllData, async () => {
    services.db.deleteAllData();
    await services.vectors.clearAll();
  });
  handle(IPC.settingsUpdate, (_event: any, updates: any) => {
    if (updates.blacklistedApps) services.settings.setBlacklistedApps(updates.blacklistedApps);
    if (updates.blacklistedWebsites) services.settings.setBlacklistedWebsites(updates.blacklistedWebsites);
    return {
      ...services.settings.snapshot(),
      googleConnected: services.google.status().connected
    };
  });

  handle(IPC.googleStatus, () => services.google.status());
  handle(IPC.googleStartAuth, () => services.google.startAuth());
  handle(IPC.googleFinishAuth, (_event: any, code: string) => services.google.finishAuth(code));
  handle(IPC.googleSetTokens, (_event: any, tokens: any) => services.google.setTokens(tokens));
  handle(IPC.googleSync, () => services.google.sync());

  
  handle(IPC.appleContactsSync, () => services.appleContacts.sync());

  handle(IPC.openScreenshotsFolder, async () => {
    return { ok: false, path: "", error: "Screenshot storage is disabled." };
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

  // Note: Since services can be replaced, we need to handle listener management
  // or use a different pattern. For now, we'll assume bootstrap handles cleanup.
  services.watcher.on("state", broadcastCaptureState);
  services.watcher.on("nudge", broadcastNudge);
  services.proactive.on("suggestions", broadcastSuggestions);
  services.proactive.on("generationState", broadcastGenState);
}

