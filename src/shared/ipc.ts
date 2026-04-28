export const IPC = {
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
  switchAccount: "switch-account"
} as const;

