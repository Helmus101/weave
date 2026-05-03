import { contextBridge, ipcRenderer } from "electron";
import type { CaptureState, ChatMessage, MemoryLayer, WeaveApi, AppSettings } from "../shared/types";

// Sandboxed Electron preload scripts cannot depend on arbitrary local runtime imports.
// Keep the IPC channel map local so the bridge can still load with sandbox enabled.
const IPC = {
  appStatus: "app:status",
  captureState: "capture:state",
  captureSetEnabled: "capture:set-enabled",
  captureRunNow: "capture:run-now",
  captureStateChanged: "capture:state-changed",
  search: "search:query",
  chatSessionCreate: "chat:session-create",
  chatSessionsGet: "chat:sessions-get",
  chatMessagesGet: "chat:messages-get",
  chatMessageSend: "chat:message-send",
  chatDeleteSession: "chat:delete-session",
  chatMessageReceived: "chat:message-received",
  chatThinkingStep: "chat:thinking-step",
  proactiveSuggestions: "proactive:suggestions",
  proactiveGenerationState: "proactive:generation-state",
  proactiveSuggestionsGenerate: "proactive:suggestions-generate",
  proactiveSuggestionsSet: "proactive:suggestions-set",
  proactiveTaskDetail: "proactive:task-detail",
  routinesTemplatesGet: "routines:templates-get",
  routinesGet: "routines:get",
  routinesSave: "routines:save",
  routinesDelete: "routines:delete",
  routinesRunNow: "routines:run-now",
  routinesRunsGet: "routines:runs-get",
  routinesRunGet: "routines:run-get",
  memoryNodesGet: "memory:nodes-get",
  memoryNodeDetails: "memory:node-details",
  memoryUpdateMetadata: "memory:update-metadata",
  memorySynthesizeEpisodes: "memory:synthesize-episodes",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsDeleteAllData: "settings:delete-all-data",
  googleStatus: "google:status",
  googleStartAuth: "google:start-auth",
  googleFinishAuth: "google:finish-auth",
  googleSetTokens: "google:set-tokens",
  googleSync: "google:sync",
  appleContactsSync: "apple-contacts:sync",
  syncProgress: "sync:progress",
  openScreenshotsFolder: "open-screenshots-folder",
  authOpenSession: "auth:open-session",
  switchAccount: "switch-account",
  quickChatSetMode: "quick-chat:set-mode",
  quickChatClose: "quick-chat:close",
  permissionsGet: "permissions:get",
  permissionsOpen: "permissions:open"
} as const;

const api: WeaveApi = {
  getBridgeStatus: () => ipcRenderer.invoke(IPC.appStatus),
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
  switchAccount: (userId: string) => ipcRenderer.invoke(IPC.switchAccount, userId),
  openAuthSession: (authUrl: string, callbackUrlPrefix: string) => ipcRenderer.invoke(IPC.authOpenSession, authUrl, callbackUrlPrefix),
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  openPermission: (pane: string) => ipcRenderer.invoke(IPC.permissionsOpen, pane),
  setQuickChatMode: (mode: "compact" | "expanded") => ipcRenderer.invoke(IPC.quickChatSetMode, mode),
  closeQuickChat: () => ipcRenderer.invoke(IPC.quickChatClose),

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
  getProactiveTaskDetail: (summary: string, plan?: string, evidence?: string) =>
    ipcRenderer.invoke(IPC.proactiveTaskDetail, summary, plan, evidence),
  getRoutineTemplates: () => ipcRenderer.invoke(IPC.routinesTemplatesGet),
  getRoutines: () => ipcRenderer.invoke(IPC.routinesGet),
  saveRoutine: (routine: any) => ipcRenderer.invoke(IPC.routinesSave, routine),
  deleteRoutine: (id: string) => ipcRenderer.invoke(IPC.routinesDelete, id),
  runRoutineNow: (id: string) => ipcRenderer.invoke(IPC.routinesRunNow, id),
  getRoutineRuns: (routineId?: string) => ipcRenderer.invoke(IPC.routinesRunsGet, routineId),
  getRoutineRun: (id: string) => ipcRenderer.invoke(IPC.routinesRunGet, id),

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
} catch (error) {
  console.error("[Preload] Failed to expose weave bridge:", error);
}
