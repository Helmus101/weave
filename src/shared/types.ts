export type CaptureStatus = "idle" | "running" | "paused" | "blocked" | "error";

export interface CaptureState {
  status: CaptureStatus;
  enabled: boolean;
  activeApp?: string;
  activeBundleId?: string;
  activeWindowTitle?: string;
  lastCaptureAt?: string;
  lastError?: string;
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
  blacklistedApps: string[];
  blacklistedWebsites: string[];
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

export interface ProactiveSuggestion {
  id: string;
  category?: "relationship" | "project";
  topic: string;
  summary: string;
  plan: string;
  immediateTasks: string[];
  aiCompletedWork?: string;
  humanTasks?: string[];
  contactName?: string;
  trigger?: string;
  whyNow?: string;
  draftMessage?: string;
  daysSinceLastContact?: number;
  createdAt: string;
  evidence?: string;
  confidence?: number;
  completedTasks?: string[];
  completedAt?: string;
}

export interface WeaveApi {
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

  onCaptureState(listener: (state: CaptureState) => void): () => void;
  onChatMessage(listener: (message: ChatMessage) => void): () => void;
  onThinkingStep(listener: (step: string) => void): () => void;
  onProactiveSuggestions(listener: (suggestions: ProactiveSuggestion[]) => void): () => void;
  onProactiveGenerationState(listener: (state: { inProgress: boolean }) => void): () => void;
  onSyncProgress(listener: (progress: SyncProgress) => void): () => void;
}
