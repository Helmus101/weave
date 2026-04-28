import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { CaptureState, ChatMessage, MemoryLayer, WeaveApi, AppSettings } from "../shared/types";

console.log("Preload script starting...");

const api: WeaveApi = {
  getCaptureState: () => ipcRenderer.invoke(IPC.captureState),
  setCaptureEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.captureSetEnabled, enabled),
  runCaptureNow: () => ipcRenderer.invoke(IPC.captureRunNow),
  
  search: (query: string) => ipcRenderer.invoke(IPC.search, query),
  
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, settings),
  deleteAllData: () => ipcRenderer.invoke(IPC.settingsDeleteAllData),
  
  getGoogleAuthStatus: () => ipcRenderer.invoke(IPC.googleStatus),
  startGoogleAuth: () => ipcRenderer.invoke(IPC.googleStartAuth),
  finishGoogleAuth: (code: string) => ipcRenderer.invoke(IPC.googleFinishAuth, code),
  setGoogleTokens: (tokens: any) => ipcRenderer.invoke(IPC.googleSetTokens, tokens),
  syncGoogle: () => ipcRenderer.invoke(IPC.googleSync),

  syncAppleContacts: () => ipcRenderer.invoke(IPC.appleContactsSync),
  openScreenshotsFolder: () => ipcRenderer.invoke(IPC.openScreenshotsFolder),

  // Chat
  createChatSession: (title?: string) => ipcRenderer.invoke(IPC.chatSessionCreate, title),
  getChatSessions: () => ipcRenderer.invoke(IPC.chatSessionsGet),
  getChatMessages: (sessionId: string) => ipcRenderer.invoke(IPC.chatMessagesGet, sessionId),
  deleteChatSession: (id: string) => ipcRenderer.invoke(IPC.chatDeleteSession, id),
  sendMessage: (sessionId: string, content: string) => ipcRenderer.invoke(IPC.chatMessageSend, sessionId, content),

  // Memory Explorer
  getMemoryNodes: (layer?: MemoryLayer) => ipcRenderer.invoke(IPC.memoryNodesGet, layer),
  getMemoryNodeDetails: (id: string) => ipcRenderer.invoke(IPC.memoryNodeDetails, id),
  updateMemoryNodeMetadata: (id: string, metadata: any) => ipcRenderer.invoke(IPC.memoryUpdateMetadata, id, metadata),
  synthesizeEpisodes: () => ipcRenderer.invoke(IPC.memorySynthesizeEpisodes),

  // Proactive
  getProactiveSuggestions: () => ipcRenderer.invoke(IPC.proactiveSuggestions),
  generateProactiveSuggestions: () => ipcRenderer.invoke(IPC.proactiveSuggestionsGenerate),
  setProactiveSuggestions: (suggestions: any[]) => ipcRenderer.invoke(IPC.proactiveSuggestionsSet, suggestions),

  onCaptureState: (listener: (state: CaptureState) => void) => {
    const wrapped = (_event: any, state: CaptureState) => listener(state);
    ipcRenderer.on(IPC.captureStateChanged, wrapped);
    return () => ipcRenderer.off(IPC.captureStateChanged, wrapped);
  },
  onChatMessage: (listener: (message: ChatMessage) => void) => {
    const wrapped = (_event: any, message: ChatMessage) => listener(message);
    ipcRenderer.on(IPC.chatMessageReceived, wrapped);
    return () => ipcRenderer.off(IPC.chatMessageReceived, wrapped);
  },
  onThinkingStep: (listener: (step: string) => void) => {
    const wrapped = (_event: any, step: string) => listener(step);
    ipcRenderer.on(IPC.chatThinkingStep, wrapped);
    return () => ipcRenderer.off(IPC.chatThinkingStep, wrapped);
  },
  onProactiveSuggestions: (listener: (suggestions: any[]) => void) => {
    const wrapped = (_event: any, suggestions: any[]) => listener(suggestions);
    ipcRenderer.on(IPC.proactiveSuggestions, wrapped);
    return () => ipcRenderer.off(IPC.proactiveSuggestions, wrapped);
  },
  onProactiveGenerationState: (listener: (state: { inProgress: boolean }) => void) => {
    const wrapped = (_event: any, state: { inProgress: boolean }) => listener(state);
    ipcRenderer.on(IPC.proactiveGenerationState, wrapped);
    return () => ipcRenderer.off(IPC.proactiveGenerationState, wrapped);
  },
  onSyncProgress: (listener: (progress: any) => void) => {
    const wrapped = (_event: any, progress: any) => listener(progress);
    ipcRenderer.on(IPC.syncProgress, wrapped);
    return () => ipcRenderer.off(IPC.syncProgress, wrapped);
  }
};

try {
  contextBridge.exposeInMainWorld("weave", api);
  console.log("Preload script: weave API exposed successfully");
} catch (e) {
  console.error("Preload script: Failed to expose weave API", e);
}
