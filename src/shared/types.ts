export type CaptureStatus = "idle" | "running" | "paused" | "blocked" | "error";
export type CaptureCadenceStatus = "healthy" | "stale" | "paused";

export interface OcrBlock {
  text: string;
  confidence: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface CaptureState {
  status: CaptureStatus;
  enabled: boolean;
  activeApp?: string;
  activeBundleId?: string;
  activeWindowTitle?: string;
  lastCaptureAt?: string;
  lastOcrAt?: string;
  lastIndexedAt?: string;
  lastIndexedNodeId?: string;
  lastError?: string;
  cadenceStatus?: CaptureCadenceStatus;
  queueDepth?: number;
  indexQueueDepth?: number;
  synthesisQueueDepth?: number;
  skippedTicks?: number;
  captureLagMs?: number;
  ocrDurationMs?: number;
  captureDurationMs?: number;
  screenPermission: "unknown" | "granted" | "denied";
}

export type MemoryLayer = "RAW" | "EPISODE" | "SEMANTIC" | "CLOUD" | "INSIGHT" | "CORE";

export interface MemoryNode {
  id: string;
  layer: MemoryLayer;
  subtype?: string;
  title: string;
  summary: string;
  canonicalText: string;
  sourceRefs?: string[];
  confidence: number;
  status: string; // Active, Decaying, Completed, Blocked
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  importance: number; // 1-10
  connectionCount: number; // Density
  lastReheated?: string; // Last time this node appeared
  anchorAt?: string;
}

export interface MemoryEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  weight: number;
  metadata: Record<string, any>;
}

export interface ExtractedEntities {
  people: string[];
  emails: string[];
  dates: string[];
  urls: string[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRetrievalTrace {
  intent?: {
    strategy: "WEB" | "BOTH";
    optimizedQuery: string;
    reason?: string;
  };
  filters?: {
    apps?: string[];
    dateStart?: string;
    dateEnd?: string;
    layers?: MemoryLayer[];
  } | null;
  trace?: {
    expandedQueries: string[];
    vectorResultsCount: number;
    bm25ResultsCount: number;
    nodesAfterFilter: number;
    initialCandidateCount: number;
    initialRankedTitles: string[];
    expandedCandidateCount: number;
    expandedFromTitles: string[];
    goldSet: string[];
    exactMatchCount?: number;
    timelineExpansionCount?: number;
    coverageSummary?: string;
  } | null;
  retrievalSteps?: {
    determineSource: {
      strategy: "WEB" | "BOTH";
      memoryUsed: boolean;
      webUsed: boolean;
      reason?: string;
    };
    defineQueries: {
      memoryQueries: string[];
      webQuery: string;
    };
    applyMemoryFilters: {
      applied: boolean;
      filters: {
        apps?: string[];
        dateStart?: string;
        dateEnd?: string;
        layers?: MemoryLayer[];
      };
      rationale: string[];
    };
    searchAndRank: {
      vectorResultsCount: number;
      bm25ResultsCount: number;
      initialCandidateCount: number;
      rankedCandidateCount: number;
      topRankedTitles: string[];
    };
    expandAndRerank: {
      expandedFromTitles: string[];
      expandedCandidateCount: number;
      finalNodeTitles: string[];
    };
  };
  memoryNodes?: string[];
  webQuery?: string;
  rawNodeIds?: string[];
  rawEventIds?: string[];
  webSources?: SourceReceipt[];
  evidence?: {
    sourceMix: Array<"memory" | "web">;
    memoryReceipts: SourceReceipt[];
    rawReceipts: SourceReceipt[];
    webReceipts: SourceReceipt[];
  };
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  thinkingTrace?: string;
  retrievalTrace?: ChatRetrievalTrace | null;
  timestamp: number;
  createdAt: string;
}

export interface SearchResult {
  nodeId: string;
  title: string;
  snippet: string;
  layer: MemoryLayer;
  score: number;
  metadata?: Record<string, any>;
}

export interface AppSettings {
  googleConnected: boolean;
  captureEnabled: boolean;
  rawCloudAllowed: boolean;
  publicMcpUrl?: string;
  externalContactResearchAllowed: boolean;
  quickChatShortcut?: string;
  deepseekConfigured?: boolean;
  deepseekApiKey?: string;
  blacklistedApps: string[];
  blacklistedWebsites: string[];
  subsystemHealth?: Record<SubsystemName, SubsystemHealth>;
}

export type SubsystemName = "capture" | "googleSync" | "appleContacts";

export interface SubsystemHealth {
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureMessage?: string;
  lastOcrAt?: string;
  lastIndexedAt?: string;
  cadenceStatus?: CaptureCadenceStatus;
  queueDepth?: number;
  indexQueueDepth?: number;
  synthesisQueueDepth?: number;
  skippedTicks?: number;
  captureLagMs?: number;
  ocrDurationMs?: number;
  captureDurationMs?: number;
  lastProactiveDurationMs?: number;
  lastRoutineDurationMs?: number;
  lastGoogleSyncDurationMs?: number;
  retrievalCoverage?: string;
}

export interface OpenFolderResult {
  ok: boolean;
  path: string;
  error?: string;
}

export interface SyncProgress {
  service: "google" | "apple";
  status: "idle" | "syncing" | "completed" | "error";
  processed: number;
  total?: number;
  currentContact?: string;
  error?: string;
}

export interface GoogleAuthStatus {
  connected: boolean;
  email?: string;
  lastSyncAt?: string;
  authUrl?: string;
  error?: string;
}

export interface BridgeStatus {
  ready: true;
  activeAccountId: string;
}

export interface SwitchAccountResult {
  ok: boolean;
  error?: string;
}

export interface AuthSessionResult {
  callbackUrl: string;
}

export interface ProactiveSuggestion {
  id: string;
  category?: "relationship" | "project";
  suggestionClass?: "relationship_nudge" | "momentum_opportunity" | "unresolved_loop" | "event_prep" | "habit_deviation" | "latent_follow_up";
  insightCategory?: "health" | "initiative" | "opportunity" | "neglected" | "asymmetry";
  lane?: "do_now" | "keep_warm";
  topic: string;
  summary: string;
  interpretation?: string;
  impliedAction?: string;
  plan: string;
  immediateTasks: string[];
  aiCompletedWork?: string;
  humanTasks?: string[];
  contactName?: string;
  trigger?: string;
  whyNow?: string;
  nextAction?: string;
  draftMessage?: string;
  daysSinceLastContact?: number;
  createdAt: string;
  evidence?: string;
  evidenceBundle?: SourceReceipt[];
  confidence?: number;
  priorityScore?: number;
  freshnessScore?: number;
  sourceMix?: Array<"memory" | "web" | "calendar" | "contacts">;
  reasonIncluded?: string;
  supportingNodeIds?: string[];
  supportingEventIds?: string[];
  completedTasks?: string[];
  completedAt?: string;
  dismissedAt?: string;
  snoozedUntil?: string;
  convertedRoutineId?: string;
  state?: "active" | "completed" | "dismissed" | "snoozed";
  noveltyKey?: string;
}

export interface SourceReceipt {
  id: string;
  kind: "memory" | "event" | "web" | "routine";
  title: string;
  snippet: string;
  app?: string;
  timestamp?: string;
  url?: string;
  layer?: MemoryLayer;
  nodeId?: string;
  eventId?: string;
  reason?: string;
}

export type RoutineCadence = "manual" | "daily" | "weekdays" | "weekly";

export interface RoutineSourceOptions {
  memory: boolean;
  calendar: boolean;
  contacts: boolean;
  web: boolean;
}

export interface RoutineDefinition {
  id: string;
  templateId?: string;
  kind: "template" | "custom";
  title: string;
  description?: string;
  prompt: string;
  cadence: RoutineCadence;
  enabled: boolean;
  timeOfDay?: string;
  weekday?: number;
  sources: RoutineSourceOptions;
  tone?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface RoutineTemplate {
  id: string;
  title: string;
  description: string;
  prompt: string;
  defaultCadence: RoutineCadence;
  defaultTimeOfDay?: string;
  sources: RoutineSourceOptions;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  title: string;
  prompt: string;
  content: string;
  createdAt: string;
  receipts: SourceReceipt[];
}

export interface PermissionStatuses {
  screen: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  screenLastVerifiedAt?: string;
  screenLastError?: string;
  accessibility: boolean;
  contacts: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  contactsLastVerifiedAt?: string;
  contactsLastError?: string;
}

export interface WeaveApi {
  getBridgeStatus(): Promise<BridgeStatus>;
  getCaptureState(): Promise<CaptureState>;
  setCaptureEnabled(enabled: boolean): Promise<CaptureState>;
  runCaptureNow(): Promise<CaptureState>;
  search(query: string): Promise<SearchResult[]>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  deleteAllData(): Promise<void>;
  getGoogleAuthStatus(): Promise<GoogleAuthStatus>;
  startGoogleAuth(): Promise<GoogleAuthStatus>;
  finishGoogleAuth(code: string): Promise<GoogleAuthStatus>;
  setGoogleTokens(tokens: { accessToken?: string; refreshToken?: string; expiryDate?: number }): Promise<GoogleAuthStatus>;
  syncGoogle(): Promise<GoogleAuthStatus>;
  switchAccount(userId: string): Promise<SwitchAccountResult>;
  openAuthSession(authUrl: string, callbackUrlPrefix: string): Promise<AuthSessionResult>;
  getPermissions(): Promise<PermissionStatuses>;
  openPermission(pane: "screen" | "accessibility" | "contacts"): Promise<void>;
  setQuickChatMode(mode: "compact" | "expanded"): Promise<void>;
  closeQuickChat(): Promise<void>;

  syncAppleContacts(): Promise<void>;
  openScreenshotsFolder(): Promise<OpenFolderResult>;
  
  // Chat
  createChatSession(title?: string): Promise<ChatSession>;
  getChatSessions(): Promise<ChatSession[]>;
  getChatMessages(sessionId: string): Promise<ChatMessage[]>;
  deleteChatSession(id: string): Promise<void>;
  sendMessage(sessionId: string, content: string): Promise<void>;
  
  // Memory Explorer
  getMemoryNodes(layer?: MemoryLayer): Promise<MemoryNode[]>;
  getMemoryNodeDetails(id: string): Promise<{ node: MemoryNode; edges: MemoryEdge[] }>;
  updateMemoryNodeMetadata(id: string, metadata: any): Promise<void>;
  synthesizeEpisodes(): Promise<void>;

  // Proactive
  getProactiveSuggestions(): Promise<ProactiveSuggestion[]>;
  generateProactiveSuggestions(): Promise<ProactiveSuggestion[]>;
  setProactiveSuggestions(suggestions: ProactiveSuggestion[]): Promise<ProactiveSuggestion[]>;
  getProactiveTaskDetail(summary: string, plan?: string, evidence?: string): Promise<string>;

  // Routines
  getRoutineTemplates(): Promise<RoutineTemplate[]>;
  getRoutines(): Promise<RoutineDefinition[]>;
  saveRoutine(routine: Partial<RoutineDefinition>): Promise<RoutineDefinition>;
  deleteRoutine(id: string): Promise<void>;
  runRoutineNow(id: string): Promise<RoutineRun>;
  getRoutineRuns(routineId?: string): Promise<RoutineRun[]>;
  getRoutineRun(id: string): Promise<RoutineRun | undefined>;

  onCaptureState(listener: (state: CaptureState) => void): () => void;
  onChatMessage(listener: (message: ChatMessage) => void): () => void;
  onThinkingStep(listener: (step: string) => void): () => void;
  onProactiveSuggestions(listener: (suggestions: ProactiveSuggestion[]) => void): () => void;
  onProactiveGenerationState(listener: (state: { inProgress: boolean }) => void): () => void;
  onSyncProgress(listener: (progress: SyncProgress) => void): () => void;
}
