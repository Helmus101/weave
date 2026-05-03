import { useEffect, useMemo, useState, useRef } from "react";
import type { ReactNode } from "react";
import { supabase } from "./lib/supabase";
import type { AuthChangeEvent, User as SupabaseUser } from "@supabase/supabase-js";

import {
  Activity,
  BookOpen,
  Calendar,
  Clock3,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Send,
  Settings,
  Shield,
  Trash2,
  User,
  ExternalLink
} from "lucide-react";
import type {
  AppSettings,
  CaptureState,
  ChatMessage,
  ChatRetrievalTrace,
  ChatSession,
  GoogleAuthStatus,
  MemoryNode,
  MemoryLayer,
  PermissionStatuses,
  ProactiveSuggestion,
  RoutineDefinition,
  RoutineRun,
  RoutineTemplate,
  SourceReceipt,
  SwitchAccountResult,
  SyncProgress,
  WeaveApi
} from "../shared/types";
import "./styles.css";
import logo from "./assets/logo.png";
import logoMark from "./assets/logo-mark.svg";

const emptyCapture: CaptureState = {
  status: "idle",
  enabled: false,
  screenPermission: "unknown"
};

// Advanced Markdown-lite renderer with table support
function renderContent(content: string | undefined | null, onContactClick?: (name: string, detail: string) => void) {
  if (!content || typeof content !== "string") return null;

  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  let currentTable: string[][] = [];
  let isTable = false;

  const flushTable = (key: number) => {
    if (currentTable.length === 0) return null;
    const hasHeaderDivider = currentTable.length > 1 && currentTable[1].every(cell => cell.trim().match(/^:?-+:?$/));
    const headerRow = hasHeaderDivider ? currentTable[0] : null;
    const bodyRows = hasHeaderDivider ? currentTable.slice(2) : currentTable;

    const tableElement = (
      <div key={`table-${key}`} style={{ overflowX: 'auto', margin: '20px 0', borderRadius: '12px', border: '1px solid var(--border-subtle)', boxShadow: '0 2px 12px rgba(0,0,0,0.03)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          {headerRow && (
            <thead>
              <tr style={{ background: '#f8f9fa', borderBottom: '1px solid var(--border-subtle)' }}>
                {headerRow.map((cell, i) => (
                  <th key={i} style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.03em' }}>{cell.trim()}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {bodyRows.map((row, i) => (
              <tr key={i} style={{ 
                background: i % 2 === 0 ? '#ffffff' : '#fafbfc',
                borderBottom: i === bodyRows.length - 1 ? 'none' : '1px solid var(--border-subtle)' 
              }}>
                {row.map((cell, j) => (
                  <td key={j} style={{ padding: '12px 16px', color: 'var(--text-primary)', lineHeight: '1.5' }}>{cell.trim()}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    currentTable = [];
    isTable = false;
    return tableElement;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Table Detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      currentTable.push(cells);
      isTable = true;
      continue;
    } else if (isTable) {
      const table = flushTable(i);
      if (table) blocks.push(table);
    }

    // Headers
    if (trimmed.startsWith('### ')) {
      blocks.push(<h3 key={i} style={{ margin: '20px 0 10px 0', fontSize: '1.1em', fontWeight: 'bold', color: 'var(--text-primary)' }}>{trimmed.replace('### ', '')}</h3>);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push(<h2 key={i} style={{ margin: '24px 0 12px 0', fontSize: '1.25em', fontWeight: 'bold', color: 'var(--text-primary)' }}>{trimmed.replace('## ', '')}</h2>);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      blocks.push(<h1 key={i} style={{ margin: '32px 0 16px 0', fontSize: '1.5em', fontWeight: 'bold', color: 'var(--text-primary)' }}>{trimmed.replace('# ', '')}</h1>);
      continue;
    }

    // Horizontal Rule
    if (trimmed === '---') {
      blocks.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '24px 0' }} />);
      continue;
    }

    // Process Inline Elements (Bold, Links, Contacts)
    // Bullet points
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      blocks.push(
        <div key={i} style={{ marginLeft: '12px', marginBottom: '8px', display: 'flex', alignItems: 'flex-start' }}>
          <span style={{ marginRight: '10px', color: 'var(--accent-primary)', fontWeight: 'bold' }}>•</span>
          <span style={{ flex: 1, lineHeight: '1.6' }}>{renderInlineRichText(line.substring(2), onContactClick)}</span>
        </div>
      );
      continue;
    }

    // Regular Paragraph
    if (trimmed === '') {
      blocks.push(<div key={i} style={{ height: '16px' }} />);
    } else {
      blocks.push(<div key={i} style={{ marginBottom: '14px', lineHeight: '1.7' }}>{renderInlineRichText(line, onContactClick)}</div>);
    }
  }

  // Final table flush
  if (isTable) {
    const table = flushTable(lines.length);
    if (table) blocks.push(table);
  }

  return <div className="rendered-content">{blocks}</div>;
}

function formatReceiptTimestampLabel(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderInlineRichText(text: string, onContactClick?: (name: string, detail: string) => void): ReactNode[] {
  const boldParts = text.split(/\*\*(.*?)\*\*/g);
  return boldParts.flatMap((part, j) => {
    if (j % 2 === 1) {
      return [<strong key={`bold-${j}`} style={{ fontWeight: "700" }}>{part}</strong>];
    }
    return renderInlineTokens(part, onContactClick, `plain-${j}`);
  });
}

function renderInlineTokens(text: string, onContactClick?: (name: string, detail: string) => void, keyPrefix = "token"): ReactNode[] {
  const tokenRegex = /@Contact\[(.*?)\]\((.*?)\)|\[(RAW|Memory|Web)\]\[([^\]]+)\](?:\[([^\]]+)\])?/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      const name = match[1];
      const detail = match[2];
      nodes.push(
        <span
          key={`${keyPrefix}-contact-${match.index}`}
          className="contact-tag"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 10px', background: 'var(--accent-secondary)',
            color: 'var(--accent-primary)', borderRadius: '14px',
            fontSize: '0.9em', fontWeight: '600', cursor: 'pointer', margin: '0 2px',
            boxShadow: '0 1px 3px rgba(66, 133, 244, 0.1)',
            transition: 'all 0.2s ease'
          }}
          onClick={() => onContactClick?.(name, detail)}
        >
          <User size={12} /> {name}
        </span>
      );
    } else {
      const receiptType = match[3] as "RAW" | "Memory" | "Web";
      const receiptSource = match[4];
      const receiptTime = match[5];
      nodes.push(
        <span key={`${keyPrefix}-receipt-${match.index}`} className={`inline-receipt-chip inline-receipt-chip-${receiptType.toLowerCase()}`}>
          <span className="inline-receipt-kind">{receiptType === "RAW" ? "Source" : receiptType}</span>
          <span className="inline-receipt-source">{receiptSource}</span>
          {receiptTime && <span className="inline-receipt-time">{formatReceiptTimestampLabel(receiptTime)}</span>}
        </span>
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}


function formatFilters(filters: ChatRetrievalTrace["filters"]) {
  if (!filters) return "None";

  const parts: string[] = [];
  if (filters.apps?.length) parts.push(`apps=${filters.apps.join(", ")}`);
  if (filters.dateStart || filters.dateEnd) parts.push(`date=${filters.dateStart || "Any"} -> ${filters.dateEnd || "Any"}`);
  if (filters.layers?.length) parts.push(`layers=${filters.layers.join(", ")}`);
  return parts.length > 0 ? parts.join(" | ") : "None";
}

function TraceSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span style={{ fontWeight: "bold", textTransform: "uppercase", fontSize: "10px", opacity: 0.6 }}>{label}</span>
      <div style={{ fontFamily: "monospace", marginTop: "4px", lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

function ReceiptList({ receipts }: { receipts: SourceReceipt[] | undefined }) {
  if (!receipts || receipts.length === 0) {
    return <div style={{ fontSize: '12px', opacity: 0.6 }}>None</div>;
  }
  return (
    <div className="receipt-list">
      {receipts.map((receipt) => (
        <div key={receipt.id} className="receipt-card">
          <div className="receipt-card-top">
            <span className={`receipt-kind-badge receipt-kind-${receipt.kind}`}>
              {receipt.kind === "event" ? "Raw" : receipt.kind === "memory" ? "Memory" : receipt.kind === "web" ? "Web" : "Routine"}
            </span>
            <div className="receipt-card-title-group">
              <div className="receipt-card-title">{receipt.title}</div>
              <div className="receipt-card-meta">
                {receipt.app && <span>{receipt.app}</span>}
                {receipt.timestamp && <span>{formatReceiptTimestampLabel(receipt.timestamp)}</span>}
                {!receipt.timestamp && receipt.url && <span>{receipt.url}</span>}
              </div>
            </div>
            {receipt.url && (
              <a className="receipt-card-link" href={receipt.url} target="_blank" rel="noreferrer">
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          <div className="receipt-card-snippet">{receipt.snippet}</div>
          {receipt.reason && <div className="receipt-card-reason">{receipt.reason}</div>}
        </div>
      ))}
    </div>
  );
}

function sanitizeThinkingStep(step: string) {
  return step
    .replace(/DeepSeek/gi, "Weave")
    .replace(/DuckDuckGo/gi, "web search");
}

function formatLastSync(lastSyncAt?: string) {
  if (!lastSyncAt) return "Not synced yet";
  const parsed = new Date(lastSyncAt);
  if (Number.isNaN(parsed.getTime())) return "Not synced yet";
  return parsed.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatStatusTimestamp(value?: string) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Never";
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRelativeTime(value?: string) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Never";
  const diffMs = Date.now() - parsed.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function suggestionClassLabel(value?: ProactiveSuggestion["suggestionClass"]) {
  switch (value) {
    case "relationship_nudge": return "Relationship";
    case "momentum_opportunity": return "Momentum";
    case "unresolved_loop": return "Open Loop";
    case "event_prep": return "Prep";
    case "habit_deviation": return "Pattern";
    case "latent_follow_up": return "Follow-up";
    default: return "Priority";
  }
}

function suggestionLaneLabel(value?: ProactiveSuggestion["lane"]) {
  return value === "keep_warm" ? "Keep Warm" : "Do Now";
}

function suggestionToneClass(value?: ProactiveSuggestion["suggestionClass"]) {
  switch (value) {
    case "relationship_nudge": return "relationship";
    case "event_prep": return "event";
    case "unresolved_loop": return "warning";
    case "momentum_opportunity": return "positive";
    case "habit_deviation": return "neutral";
    case "latent_follow_up": return "soft";
    default: return "neutral";
  }
}

function computeNextRoutineRun(routine: RoutineDefinition) {
  if (!routine.enabled || routine.cadence === "manual" || !routine.timeOfDay) return null;
  const [hours, minutes] = routine.timeOfDay.split(":").map((part) => Number(part) || 0);
  const next = new Date();
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);

  const advanceDay = (count: number) => {
    next.setDate(next.getDate() + count);
  };

  if (next.getTime() <= Date.now()) {
    advanceDay(1);
  }

  if (routine.cadence === "weekdays") {
    while (next.getDay() === 0 || next.getDay() === 6) advanceDay(1);
  } else if (routine.cadence === "weekly") {
    const targetDay = routine.weekday ?? 1;
    while (next.getDay() !== targetDay || next.getTime() <= Date.now()) {
      advanceDay(1);
    }
  }

  return next.toISOString();
}

function permissionLabel(status: "granted" | "denied" | "restricted" | "not-determined" | "unknown") {
  if (status === "granted") return "Granted";
  if (status === "denied") return "Denied";
  if (status === "restricted") return "Restricted";
  if (status === "not-determined") return "Not Determined";
  return "Unknown";
}

type PermissionStatusValue = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export default function App() {
  const [bridgeApi, setBridgeApi] = useState<WeaveApi | null>(null);
  const weave = bridgeApi;
  const isQuickChatMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "quick-chat";
  const [startupState, setStartupState] = useState<"loadingBridge" | "loadingAppState" | "switchingAccount" | "ready" | "startupError">("loadingBridge");
  const [startupError, setStartupError] = useState("");
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [view, setView] = useState<"home" | "chat" | "settings" | "explorer" | "contacts" | "routines">(isQuickChatMode ? "chat" : "home");
  const [supabaseUser, setSupabaseUser] = useState<SupabaseUser | null>(null);
  const lastSwitchedUserId = useRef<string | null>(null);
  const isInitializingRef = useRef(false);
  const activeAccountIdRef = useRef("default");
  const authTransitionRef = useRef(0);


  const [capture, setCapture] = useState<CaptureState>(emptyCapture);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [isDraftChat, setIsDraftChat] = useState(isQuickChatMode);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [settings, setSettings] = useState<AppSettings>();
  const [google, setGoogle] = useState<GoogleAuthStatus>({ connected: false });
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [settingsStatus, setSettingsStatus] = useState<string>("");
  const [publicMcpUrlDraft, setPublicMcpUrlDraft] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState<ProactiveSuggestion | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
  const [typedMessageContent, setTypedMessageContent] = useState("");
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [permissions, setPermissions] = useState<PermissionStatuses | null>(null);
  const [taskDetail, setTaskDetail] = useState<string | null>(null);
  const [isLoadingTaskDetail, setIsLoadingTaskDetail] = useState(false);
  const [routineTemplates, setRoutineTemplates] = useState<RoutineTemplate[]>([]);
  const [routines, setRoutines] = useState<RoutineDefinition[]>([]);
  const [routineRuns, setRoutineRuns] = useState<RoutineRun[]>([]);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Partial<RoutineDefinition> | null>(null);
  const [isRunningRoutineId, setIsRunningRoutineId] = useState<string | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastCaptureUpdateAtRef = useRef(0);
  const lastNodesFetchAtRef = useRef(0);
  const currentSessionIdRef = useRef<string | undefined>(undefined);

  const rankedSuggestions = useMemo(
    () => (suggestions || [])
      .filter((s) => s.state === "active")
      .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0)),
    [suggestions]
  );
  const relationshipNudges = useMemo(
    () => rankedSuggestions
      .filter((s) => s.category === "relationship")
      .slice(0, 3),
    [rankedSuggestions]
  );
  const doNowSuggestions = useMemo(
    () => rankedSuggestions
      .filter((s) => s.lane !== "keep_warm" && s.category !== "relationship")
      .slice(0, 4),
    [rankedSuggestions]
  );
  const keepWarmSuggestions = useMemo(
    () => rankedSuggestions
      .filter((s) => s.lane === "keep_warm" && s.category !== "relationship")
      .slice(0, 4),
    [rankedSuggestions]
  );
  const publicMcpReady = Boolean(settings?.rawCloudAllowed && /^https:\/\//i.test(settings?.publicMcpUrl || ""));

  const totalActiveSuggestions = rankedSuggestions.length;
  const peopleNodes = useMemo(
    () => nodes.filter((n) => n.layer === "SEMANTIC" && n.subtype === "person"),
    [nodes]
  );
  const firstName = (supabaseUser?.user_metadata?.full_name || supabaseUser?.user_metadata?.name || google?.email?.split('@')[0] || 'there').split(' ')[0];
  const activeAppName = capture?.activeApp || "";
  const personalizedGreeting = activeAppName
    ? `Hello, ${firstName}. You're in ${activeAppName} right now.`
    : `Hello, ${firstName}.`;
  const isDraftChatView = view === "chat" && isDraftChat && messages.length === 0 && thinkingSteps.length === 0;
  const selectedRoutine = routines.find((routine) => routine.id === selectedRoutineId) || null;
  const selectedRoutineRuns = routineRuns.filter((run) => !selectedRoutineId || run.routineId === selectedRoutineId);
  const nextRoutineRuns = useMemo(
    () => routines
      .map((routine) => ({ routine, nextRunAt: computeNextRoutineRun(routine) }))
      .filter((entry) => Boolean(entry.nextRunAt))
      .sort((a, b) => new Date(a.nextRunAt || 0).getTime() - new Date(b.nextRunAt || 0).getTime()),
    [routines]
  );

  useEffect(() => {
    setPublicMcpUrlDraft(settings?.publicMcpUrl || "");
  }, [settings?.publicMcpUrl]);

  function getBridge(): WeaveApi | null {
    return ((window as any).weave as WeaveApi | undefined) ?? null;
  }

  async function waitForBridge(timeoutMs = 3000): Promise<WeaveApi> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const api = getBridge();
      if (api) return api;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Weave bridge did not become available. This usually means the Electron preload did not attach.");
  }

  async function ensureActiveAccount(api: WeaveApi, user: SupabaseUser | null) {
    const desiredAccountId = user?.id || "default";
    const status = await api.getBridgeStatus();
    if (status.activeAccountId !== desiredAccountId) {
      setStartupState(user ? "switchingAccount" : "loadingAppState");
      const result = await api.switchAccount(desiredAccountId);
      const parsed = result as SwitchAccountResult;
      if (!parsed?.ok) {
        throw new Error(parsed?.error || "Failed to switch the local account.");
      }
    }
    activeAccountIdRef.current = desiredAccountId;
    lastSwitchedUserId.current = user?.id ?? null;
  }

  function shouldIgnoreAuthTransition(event: AuthChangeEvent, user: SupabaseUser | null) {
    if (user) return false;
    return event !== "SIGNED_OUT";
  }

  async function refresh(api = weave) {
    if (!api) return;
    try {
      const [captureState, chatSessions, appSettings, googleStatus, proactiveS] = await Promise.all([
        api.getCaptureState(),
        api.getChatSessions(),
        api.getSettings(),
        api.getGoogleAuthStatus(),
        api.getProactiveSuggestions()
      ]);
      setCapture(captureState || emptyCapture);
      setSessions(Array.isArray(chatSessions) ? chatSessions : []);
      setSettings(appSettings);
      setGoogle(googleStatus || { connected: false });
      setSuggestions(Array.isArray(proactiveS) ? proactiveS : []);
      
      if (!isQuickChatMode && Array.isArray(chatSessions) && chatSessions.length > 0 && !currentSessionId && !isDraftChat) {
        setCurrentSessionId(chatSessions[0].id);
      }
    } catch (e) {
      console.error("Refresh error:", e);
    }
  }

  async function refreshRoutines(api = weave) {
    if (!api) return;
    try {
      const [templates, routineDefs, runs] = await Promise.all([
        api.getRoutineTemplates(),
        api.getRoutines(),
        api.getRoutineRuns()
      ]);
      setRoutineTemplates(Array.isArray(templates) ? templates : []);
      setRoutines(Array.isArray(routineDefs) ? routineDefs : []);
      setRoutineRuns(Array.isArray(runs) ? runs : []);
    } catch (error) {
      console.error("Routine refresh error:", error);
    }
  }
  useEffect(() => {
    let cancelled = false;
    isInitializingRef.current = true;

    const initialize = async () => {
      setStartupError("");
      setStartupState("loadingBridge");
      try {
        const api = await waitForBridge();
        if (cancelled) return;
        setBridgeApi(api);

        await api.getBridgeStatus();
        if (cancelled) return;
        setStartupState("loadingAppState");

        const { data: { session } } = await supabase.auth.getSession();
        const user = session?.user ?? null;
        if (cancelled) return;
        setSupabaseUser(user);
        await ensureActiveAccount(api, user);
        if (cancelled) return;
        await Promise.all([refresh(api), refreshRoutines(api)]);
        if (cancelled) return;
        setStartupState("ready");
      } catch (error: any) {
        if (cancelled) return;
        setStartupError(error?.message || "Weave could not finish startup.");
        setStartupState("startupError");
      } finally {
        isInitializingRef.current = false;
      }
    };

    void initialize();
    return () => {
      cancelled = true;
      isInitializingRef.current = false;
    };
  }, [startupAttempt]);

  useEffect(() => {
    if (!weave) return;

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (isInitializingRef.current) return;
      const user = session?.user ?? null;
      if (shouldIgnoreAuthTransition(event, user)) {
        return;
      }
      const desiredAccountId = user?.id || "default";
      if (desiredAccountId === activeAccountIdRef.current && (user?.id ?? null) === lastSwitchedUserId.current) {
        setSupabaseUser(user);
        return;
      }
      const transitionId = ++authTransitionRef.current;

      setStartupError("");
      setStartupState(user ? "switchingAccount" : "loadingAppState");
      setSupabaseUser(user);
      try {
        await ensureActiveAccount(weave, user);
        if (transitionId !== authTransitionRef.current) return;
        await Promise.all([refresh(weave), refreshRoutines(weave)]);
        if (transitionId !== authTransitionRef.current) return;
        setStartupState("ready");
      } catch (error: any) {
        if (transitionId !== authTransitionRef.current) return;
        setStartupError(error?.message || "Weave could not switch accounts.");
        setStartupState("startupError");
      }
    });

    return () => subscription.unsubscribe();
  }, [weave]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  useEffect(() => {
    if (startupState !== "ready" || !weave) return;
    void refresh();
    
    const unsubCapture = weave.onCaptureState?.((nextCapture: CaptureState) => {
      const next = nextCapture || emptyCapture;
      setCapture((prev) => {
        const now = Date.now();
        const isSignificantStateChange =
          next.enabled !== prev.enabled ||
          next.status !== prev.status ||
          next.screenPermission !== prev.screenPermission;

        if (!isSignificantStateChange && (now - lastCaptureUpdateAtRef.current) < 300) {
          return prev;
        }

        lastCaptureUpdateAtRef.current = now;
        return next;
      });
      setSettings((prev) => {
        if (!prev) return prev;
        const currentHealth = prev.subsystemHealth?.capture;
        const subsystemHealth = prev.subsystemHealth || {
          capture: {},
          googleSync: {},
          appleContacts: {}
        };
        const hasSuccessfulCapture = Boolean(next.lastCaptureAt);
        const nextHealth = {
          ...(currentHealth || {}),
          lastSuccessAt: hasSuccessfulCapture ? next.lastCaptureAt : currentHealth?.lastSuccessAt,
          lastOcrAt: next.lastOcrAt || currentHealth?.lastOcrAt,
          lastIndexedAt: next.lastIndexedAt || currentHealth?.lastIndexedAt,
          cadenceStatus: next.cadenceStatus || currentHealth?.cadenceStatus,
          lastFailureAt: hasSuccessfulCapture
            ? undefined
            : next.status === "error" || next.status === "blocked"
            ? new Date().toISOString()
            : currentHealth?.lastFailureAt,
          lastFailureMessage: hasSuccessfulCapture
            ? undefined
            : next.lastError || (next.status === "running" ? undefined : currentHealth?.lastFailureMessage)
        };
        if (
          nextHealth.lastSuccessAt === currentHealth?.lastSuccessAt &&
          nextHealth.lastOcrAt === currentHealth?.lastOcrAt &&
          nextHealth.lastIndexedAt === currentHealth?.lastIndexedAt &&
          nextHealth.cadenceStatus === currentHealth?.cadenceStatus &&
          nextHealth.lastFailureAt === currentHealth?.lastFailureAt &&
          nextHealth.lastFailureMessage === currentHealth?.lastFailureMessage
        ) {
          return prev;
        }
        return {
          ...prev,
          subsystemHealth: {
            ...subsystemHealth,
            capture: nextHealth
          }
        };
      });
    });
    const unsubChat = weave.onChatMessage?.((msg: ChatMessage) => {
      if (msg && msg.sessionId === currentSessionIdRef.current) {
        setMessages(prev => {
          const existing = Array.isArray(prev) ? prev : [];
          return existing.some((message) => message.id === msg.id)
            ? existing
            : [...existing, msg];
        });
        setThinkingSteps([]); // Clear on completion
        if (msg.role === "assistant" && msg.content) {
          setTypingMessageId(msg.id);
          setTypedMessageContent("");
        }
      }
    });
    const unsubThinking = weave.onThinkingStep?.((step: string) => {
      setThinkingSteps(prev => [...prev, sanitizeThinkingStep(step)]);
    });
    const unsubProactive = weave.onProactiveSuggestions?.((s: any) => {
      setSuggestions(Array.isArray(s) ? s : []);
    });
    const unsubProactiveGenerationState = weave.onProactiveGenerationState?.((state: { inProgress: boolean }) => {
      setIsGeneratingSuggestions(!!state?.inProgress);
    });
    const unsubSync = weave.onSyncProgress?.((p: SyncProgress) => {
      setSyncProgress(p);
      if (p.service === "google" && (p.status === "completed" || p.status === "error")) {
        void weave.getGoogleAuthStatus().then((status: GoogleAuthStatus) => {
          setGoogle(status || { connected: false });
        });
      }
      if (p.status === "completed" || p.status === "error") {
        setTimeout(() => setSyncProgress(null), 5000);
      }
    });

    return () => {
      unsubCapture?.();
      unsubChat?.();
      unsubThinking?.();
      unsubProactive?.();
      unsubProactiveGenerationState?.();
      unsubSync?.();
    };
  }, [startupState, currentSessionId, weave]);

  useEffect(() => {
    if (currentSessionId && weave) {
      void weave.getChatMessages(currentSessionId).then((msgs: any) => {
        setMessages(Array.isArray(msgs) ? msgs : []);
      });
      return;
    }
    if (!currentSessionId && isDraftChat) {
      setMessages([]);
    }
  }, [currentSessionId, isDraftChat, startupState, weave]);

  useEffect(() => {
    if ((view !== "explorer" && view !== "contacts") || !weave) return;
    const now = Date.now();
    if (nodes.length > 0 && (now - lastNodesFetchAtRef.current) < 45_000) return;
    lastNodesFetchAtRef.current = now;
    void weave.getMemoryNodes().then((n: any) => setNodes(Array.isArray(n) ? n : []));
  }, [view, startupState, nodes.length, weave]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typedMessageContent]);

  useEffect(() => {
    if (!selectedSuggestion || !weave) {
      setTaskDetail(null);
      setIsLoadingTaskDetail(false);
      return;
    }
    let cancelled = false;
    setTaskDetail(null);
    setIsLoadingTaskDetail(true);
    void weave
      .getProactiveTaskDetail(
        selectedSuggestion.summary,
        selectedSuggestion.plan,
        selectedSuggestion.evidence
      )
      .then((detail) => { if (!cancelled) setTaskDetail(detail || null); })
      .catch(() => { if (!cancelled) setTaskDetail(null); })
      .finally(() => { if (!cancelled) setIsLoadingTaskDetail(false); });
    return () => {
      cancelled = true;
      setIsLoadingTaskDetail(false);
    };
  }, [selectedSuggestion?.id, weave]);

  useEffect(() => {
    if (view !== "settings" || !weave) return;
    const refresh = () => void weave.getPermissions().then(p => setPermissions(p)).catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [view, weave]);

  useEffect(() => {
    if (view !== "routines" || !weave) return;
    void refreshRoutines(weave);
  }, [view, weave]);

  useEffect(() => {
    if (!typingMessageId || view !== "chat") return;
    const target = messages.find((m) => m.id === typingMessageId && m.role === "assistant");
    if (!target) return;

    const fullText = target.content || "";
    if (!fullText) {
      setTypingMessageId(null);
      return;
    }

    const interval = setInterval(() => {
      setTypedMessageContent((prev) => {
        if (prev.length >= fullText.length) {
          clearInterval(interval);
          setTypingMessageId(null);
          return fullText;
        }
        // Small early chunks create a real typing feel; later chunks speed up long responses.
        const chunkSize = prev.length < 120 ? 1 : prev.length < 320 ? 2 : 4;
        const nextLength = Math.min(fullText.length, prev.length + chunkSize);
        return fullText.slice(0, nextLength);
      });
    }, 16);

    return () => clearInterval(interval);
  }, [typingMessageId, messages, view]);

  useEffect(() => {
    if (!isQuickChatMode || !weave || startupState !== "ready") return;
    void weave.setQuickChatMode(isDraftChatView ? "compact" : "expanded");
  }, [isQuickChatMode, isDraftChatView, startupState, weave]);

  async function sendMessage(overrideContent?: string) {
    const finalContent = overrideContent || input;
    if (!finalContent.trim() || isProcessing || !weave) return;
    
    let sessionId = currentSessionId;
    
    // Lazy create session if this is a "Ghost Chat" (pending state)
    if (!sessionId) {
      try {
        const sessionTitle = isQuickChatMode
          ? `Quick Chat ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
          : `Chat ${(sessions?.length || 0) + 1}`;
        const session = await weave.createChatSession(sessionTitle);
        setSessions(prev => [session, ...(Array.isArray(prev) ? prev : [])]);
        setCurrentSessionId(session.id);
        currentSessionIdRef.current = session.id;
        setIsDraftChat(false);
        if (isQuickChatMode) {
          setView("chat");
          await weave.setQuickChatMode("expanded");
        }
        sessionId = session.id;
      } catch (e) {
        console.error("Lazy create session error:", e);
        return;
      }
    }
    if (!sessionId) return;

    const content = finalContent;
    setInput("");
    setIsProcessing(true);
    setThinkingSteps(["Analyzing query..."]);
    
    const tempUserMsg: ChatMessage = {
      id: "temp-" + Date.now(),
      sessionId: sessionId,
      role: "user",
      content,
      timestamp: Date.now(),
      createdAt: new Date().toISOString()
    };
    setMessages(prev => [...(Array.isArray(prev) ? prev : []), tempUserMsg]);
    
    try {
      await weave.sendMessage(sessionId, content);
      const syncedMessages = await weave.getChatMessages(sessionId);
      setMessages(Array.isArray(syncedMessages) ? syncedMessages : []);
    } catch (e) {
      console.error("Send message error:", e);
    } finally {
      setIsProcessing(false);
      setThinkingSteps([]);
    }
  }

  async function startNewChat() {
    // Return to "Ghost Chat" state: no session ID, no messages, but on the chat view
    setIsDraftChat(true);
    setCurrentSessionId(undefined);
    setMessages([]);
    setThinkingSteps([]);
    setTypingMessageId(null);
    setTypedMessageContent("");
    setView("chat");
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 100);
  }

  async function goToChat() {
    await startNewChat();
  }

  function openRoutineEditor(seed?: Partial<RoutineDefinition>) {
    setEditingRoutine({
      cadence: "manual",
      enabled: true,
      sources: { memory: true, calendar: true, contacts: false, web: true },
      ...seed
    });
  }

  async function saveRoutineDraft() {
    if (!weave || !editingRoutine?.title || !editingRoutine?.prompt) return;
    const saved = await weave.saveRoutine(editingRoutine);
    setEditingRoutine(null);
    setSelectedRoutineId(saved.id);
    await refreshRoutines(weave);
  }

  async function runRoutineNow(routineId: string) {
    if (!weave) return;
    setIsRunningRoutineId(routineId);
    try {
      const run = await weave.runRoutineNow(routineId);
      setSelectedRoutineId(routineId);
      setRoutineRuns((prev) => [run, ...(Array.isArray(prev) ? prev : [])]);
      await refreshRoutines(weave);
      setSettingsStatus(`Routine generated: ${run.title}`);
    } catch (error: any) {
      setSettingsStatus(`Routine run failed: ${error?.message || "Unknown error"}`);
    } finally {
      setIsRunningRoutineId(null);
    }
  }

  async function dismissSuggestion(suggestion: ProactiveSuggestion) {
    if (!weave) return;
    const next = suggestions.map((item) =>
      item.id === suggestion.id
        ? { ...item, state: "dismissed" as const, dismissedAt: new Date().toISOString() }
        : item
    );
    setSuggestions(next);
    await weave.setProactiveSuggestions(next);
    setSelectedSuggestion(null);
  }

  async function snoozeSuggestion(suggestion: ProactiveSuggestion) {
    if (!weave) return;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const next = suggestions.map((item) =>
      item.id === suggestion.id
        ? { ...item, state: "snoozed" as const, snoozedUntil: tomorrow }
        : item
    );
    setSuggestions(next);
    await weave.setProactiveSuggestions(next);
    setSelectedSuggestion(null);
  }

  async function convertSuggestionToRoutine(suggestion: ProactiveSuggestion) {
    if (!weave) return;
    const cadence = suggestion.suggestionClass === "relationship_nudge"
      ? "weekdays"
      : suggestion.suggestionClass === "habit_deviation"
        ? "daily"
        : suggestion.suggestionClass === "event_prep"
          ? "weekdays"
          : "weekly";
    const timeOfDay = suggestion.suggestionClass === "event_prep"
      ? "07:45"
      : suggestion.suggestionClass === "relationship_nudge"
        ? "16:00"
        : "09:00";
    const routine = await weave.saveRoutine({
      title: suggestion.contactName ? `${suggestion.contactName} Relationship Brief` : suggestion.summary,
      description: suggestion.whyNow || suggestion.reasonIncluded || suggestion.interpretation || suggestion.plan,
      prompt: `You are my chief-of-staff assistant. Turn this standing priority into a clean briefing.\n\nTopic: ${suggestion.topic}\nSummary: ${suggestion.summary}\nLane: ${suggestionLaneLabel(suggestion.lane)}\nWhy now: ${suggestion.whyNow || suggestion.reasonIncluded || suggestion.interpretation || suggestion.plan}\nNext action: ${suggestion.nextAction || suggestion.impliedAction || suggestion.immediateTasks?.[0] || "Determine the next move"}\nEvidence: ${suggestion.evidence || ""}\n\nUse my memory and recent context to produce:\n- a short executive summary\n- what changed since the last time this routine ran\n- the most important next action\n- blockers or follow-ups\n- a draft or checklist if useful\n\nUse inline receipts when citing facts.`,
      cadence,
      enabled: true,
      timeOfDay,
      sources: {
        memory: true,
        calendar: suggestion.suggestionClass === "event_prep" || suggestion.suggestionClass === "momentum_opportunity",
        contacts: suggestion.category === "relationship",
        web: suggestion.suggestionClass === "momentum_opportunity"
      },
      tone: "Calm, professional, evidence-first, and operational."
    });
    const next = suggestions.map((item) =>
      item.id === suggestion.id
        ? { ...item, convertedRoutineId: routine.id, state: "completed" as const, completedAt: new Date().toISOString() }
        : item
    );
    setSuggestions(next);
    await weave.setProactiveSuggestions(next);
    await refreshRoutines(weave);
    setSelectedSuggestion(null);
    setView("routines");
    setSelectedRoutineId(routine.id);
  }





  async function loginWithGoogle() {
    if (!weave) return;
    try {
      const redirectTo = "http://localhost:3000/";
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          skipBrowserRedirect: true,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
          redirectTo,
        },
      });
      if (error) throw error;
      if (!data?.url) {
        throw new Error("Supabase did not return an OAuth URL.");
      }

      const { callbackUrl } = await weave.openAuthSession(data.url, redirectTo);
      const parsed = new URL(callbackUrl);
      const authCode = parsed.searchParams.get("code");
      if (!authCode) {
        const authError = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
        throw new Error(authError || "Sign-in completed without an authorization code.");
      }

      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(authCode);
      if (exchangeError) throw exchangeError;
    } catch (e) {
      console.error("Login error:", e);
    }
  }

  async function logout() {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("Logout error:", e);
    }
  }

  async function generateSuggestionsNow() {

    if (!weave || isGeneratingSuggestions) return;
    setIsGeneratingSuggestions(true);
    try {
      await weave.generateProactiveSuggestions();
      await refresh();
    } catch (error) {
      console.error("Generate suggestions failed:", error);
    } finally {
      setIsGeneratingSuggestions(false);
    }
  }

  const deleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this chat?") || !weave) return;
    const wasCurrentSession = currentSessionId === id;
    await weave.deleteChatSession(id);
    const updated = await weave.getChatSessions();
    setSessions(updated);
    if (wasCurrentSession && updated.length > 0) {
      setIsDraftChat(false);
      setCurrentSessionId(updated[0].id);
    } else if (updated.length === 0) {
      setIsDraftChat(true);
      setCurrentSessionId(undefined);
      setMessages([]);
    }
  };

  const getProactivePrompts = () => {
    const app = capture?.activeApp || "your current activity";
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    if (app.toLowerCase().includes("code") || app.toLowerCase().includes("studio")) {
      return [
        `What were my main technical blockers today in ${app}?`,
        `Summarize the logic changes I've been making to ${app} since ${time}.`,
        `Are there any unaddressed TO-DOs or comments I left in ${app} recently?`
      ];
    }
    
    if (app.toLowerCase().includes("chrome") || app.toLowerCase().includes("safari") || app.toLowerCase().includes("browser")) {
      return [
        `I've been browsing for a while—what research thread was I just following?`,
        `Create a summary of the articles I read in the last hour.`,
        `Did I find the solution to the problem I was searching for?`
      ];
    }

    return [
      `What have I accomplished so far this session?`,
      `Help me plan my next steps based on my recent activity in ${app}.`,
      `Summarize my morning—what were the key highlights?`
    ];
  };

  if (startupState !== "ready" || !weave) {
    const heading = startupState === "switchingAccount"
      ? "Switching to your local account..."
      : startupState === "startupError"
        ? "Weave couldn't finish startup"
        : "Initializing Weave Memory Graph...";
    const detail = startupState === "switchingAccount"
      ? "Preparing your private database..."
      : startupState === "startupError"
        ? startupError || "The bridge or initial local state could not be loaded."
        : startupState === "loadingAppState"
          ? "Loading local state..."
          : "Waiting for bridge connection...";
    return (
      <div className="empty-state" style={{ height: '100vh', flexDirection: 'column', gap: '20px' }}>
        {startupState === "startupError" ? <Shield /> : <RefreshCw className="spin" />}
        <div>{heading}</div>
        <div style={{ fontSize: '12px', opacity: 0.7, maxWidth: '420px', textAlign: 'center', lineHeight: 1.5 }}>{detail}</div>
        {startupState === "startupError" && (
          <button className="primary-button" onClick={() => setStartupAttempt((attempt) => attempt + 1)}>
            Retry Startup
          </button>
        )}
        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          .spin { animation: spin 2s linear infinite; }
        `}</style>
      </div>
    );
  }


  if (!supabaseUser) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-app)', padding: isQuickChatMode ? '24px' : '40px' }}>
        <div style={{ 
          maxWidth: isQuickChatMode ? '420px' : '440px', width: '100%', padding: isQuickChatMode ? '32px' : '48px', 
          background: '#fff', borderRadius: '32px', boxShadow: '0 24px 64px rgba(0,0,0,0.06)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '32px', textAlign: 'center'
        }}>
          <img src={logo} alt="Weave Logo" style={{ width: '80px', height: '80px', borderRadius: '20px', boxShadow: '0 12px 24px rgba(0,0,0,0.05)' }} />
          <div>
            <h1 style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.04em', margin: '0 0 8px 0' }}>Welcome to Weave</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, fontSize: '15px' }}>Your personal memory layer. Securely sync your digital life and unlock proactive relationship intelligence.</p>
          </div>
          <button 
            className="primary-button" 
            onClick={loginWithGoogle}
            style={{ width: '100%', height: '56px', borderRadius: '16px', fontSize: '16px', gap: '12px' }}
          >
            <User size={20} />
            Continue with Google
          </button>
          <div style={{ fontSize: '12px', opacity: 0.5 }}>
            By continuing, you enable Weave to securely process your local activity and Google data.
          </div>
        </div>
      </div>
    );
  }

  if (isQuickChatMode) {
    return (
      <div className="quick-chat-root">
        <div className={`quick-chat-panel ${isDraftChatView ? 'draft' : 'expanded'}`}>
          {isDraftChatView ? (
            <div className="quick-chat-compact-shell">
              <img src={logoMark} alt="Weave Logo" className="quick-chat-logo compact" />
              <div className="quick-chat-compact-input">
                <div className="quick-chat-compact-label">Weave</div>
                <div className="quick-chat-compact-subtitle">Ask from anywhere</div>
              </div>
              <button className="secondary-button quick-chat-close-pill" onClick={() => { void weave.closeQuickChat(); }}>
                Close
              </button>
            </div>
          ) : (
            <>
              <div className="quick-chat-header">
                <div className="quick-chat-title-group">
                  <img src={logoMark} alt="Weave Logo" className="quick-chat-logo" />
                  <div>
                    <div className="quick-chat-eyebrow">Quick Chat</div>
                    <div className="quick-chat-title">
                      {sessions.find((session) => session.id === currentSessionId)?.title || "Quick Chat"}
                    </div>
                  </div>
                </div>
                <div className="quick-chat-actions">
                  <button className="secondary-button quick-chat-action-button" onClick={startNewChat}>
                    New
                  </button>
                  <button className="secondary-button quick-chat-action-button" onClick={() => { void weave.closeQuickChat(); }}>
                    Close
                  </button>
                </div>
              </div>

            <div className="quick-chat-messages">
              {messages?.map((m) => (
                <div key={m.id} className={`message-bubble ${m.role} quick`}>
                  <div className="bubble-header">
                    <span className="sender">{m.role === 'user' ? 'You' : 'Weave'}</span>
                    <span className="time">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="bubble-text">
                    {renderContent(m.id === typingMessageId ? typedMessageContent : m.content)}
                  </div>
                </div>
              ))}

              {thinkingSteps.length > 0 && (
                <div className="message-bubble assistant thinking quick">
                  <div className="thinking-indicator">
                    <div className="dot"></div>
                    <div className="dot"></div>
                    <div className="dot"></div>
                    <span className="thinking-text">{thinkingSteps[thinkingSteps.length - 1]}</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
            </>
          )}

          <div className="quick-chat-composer">
            <div className="input-box-refined quick-chat-input-box">
              <textarea
                placeholder={isDraftChatView ? "Type a message..." : "Reply..."}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
                rows={1}
              />
              <button
                className={`send-button-refined ${input.trim() ? 'active' : ''}`}
                onClick={() => { void sendMessage(); }}
                disabled={isProcessing || !input.trim()}
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (

    <div className="app-container">
      <main className="main-area">

        <header className="top-bar">
          <div className="status-band">
            <div className="status-item">
              <Shield size={16} />
              <span>{capture?.enabled ? "Watching Memory" : "Paused"}</span>
            </div>
            <div className="status-item">
              <Activity size={16} />
              <span>{capture?.activeApp || "Idle"}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="secondary-button" onClick={() => void refresh()} title="Refresh">
              <RefreshCw size={16} />
            </button>
            <button 
              className={capture?.enabled ? "primary-button" : "secondary-button"} 
              onClick={() => weave.setCaptureEnabled(!capture?.enabled)}
            >
              {capture?.enabled ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
              {capture?.enabled ? "Stop" : "Resume"}
            </button>
          </div>
        </header>

        {view === "home" && (
          <div className="executive-dashboard">
            <div className="executive-hero">
              <div className="executive-hero-main">
                <img src={logo} alt="Weave Logo" className="executive-hero-logo" />
                <div>
                  <h1 className="executive-hero-title">
                    {new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'}, {(supabaseUser?.user_metadata?.full_name || supabaseUser?.user_metadata?.name || google?.email?.split('@')[0] || 'there').split(' ')[0]}.
                  </h1>
                  <p className="executive-hero-copy">
                    Your memory graph is prioritizing a short list of high-conviction actions, relationship moves, and routines worth your attention.
                  </p>
                </div>
              </div>
              <button
                className="secondary-button executive-refresh"
                onClick={generateSuggestionsNow}
                disabled={isGeneratingSuggestions}
              >
                {isGeneratingSuggestions ? 'Refreshing Brief' : 'Refresh Brief'}
              </button>
            </div>

            <div className="executive-summary-grid">
              <div className="executive-summary-card">
                <div className="executive-summary-label"><Shield size={14} /> Capture</div>
                <div className="executive-summary-value">{capture?.enabled ? "Watching" : "Paused"}</div>
                <div className="executive-summary-meta">
                  {capture?.lastIndexedAt ? `Last indexed ${formatRelativeTime(capture.lastIndexedAt)}` : "No recent indexed snapshot"}
                </div>
              </div>
              <div className="executive-summary-card">
                <div className="executive-summary-label"><Activity size={14} /> Priorities</div>
                <div className="executive-summary-value">{totalActiveSuggestions}</div>
                <div className="executive-summary-meta">
                  {doNowSuggestions.length} do now · {keepWarmSuggestions.length} keep warm
                </div>
              </div>
              <div className="executive-summary-card">
                <div className="executive-summary-label"><Calendar size={14} /> Next Routine</div>
                <div className="executive-summary-value">{nextRoutineRuns[0]?.routine.title || "None scheduled"}</div>
                <div className="executive-summary-meta">
                  {nextRoutineRuns[0]?.nextRunAt ? formatStatusTimestamp(nextRoutineRuns[0].nextRunAt) : "Create a routine to automate a recurring brief"}
                </div>
              </div>
              <div className="executive-summary-card">
                <div className="executive-summary-label"><Clock3 size={14} /> Posture</div>
                <div className="executive-summary-value">{capture?.activeApp || "Idle"}</div>
                <div className="executive-summary-meta">
                  {isGeneratingSuggestions ? "Re-ranking recent memory and activity..." : "Current working context"}
                </div>
              </div>
            </div>

            {totalActiveSuggestions === 0 ? (
              <div className="executive-empty-state">
                <Activity size={30} />
                <div className="executive-empty-title">Building your operating brief</div>
                <div className="executive-empty-copy">
                  Weave is reviewing recent captures, timelines, relationships, and calendar signals to surface the few actions that matter most.
                </div>
              </div>
            ) : (
              <>
                <div className="home-section">
                  <div className="section-header">
                    <div className="header-title">
                      <h2>Do Now</h2>
                    </div>
                    <span className="section-kicker">High-conviction actions</span>
                  </div>
                  <div className="suggestion-card-grid">
                    {doNowSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        className={`executive-suggestion-card tone-${suggestionToneClass(suggestion.suggestionClass)}`}
                        onClick={() => setSelectedSuggestion(suggestion)}
                      >
                        <div className="executive-card-topline">
                          <span className="executive-chip">{suggestionLaneLabel(suggestion.lane)}</span>
                          <span className="executive-chip subtle">{suggestionClassLabel(suggestion.suggestionClass)}</span>
                          <span className="executive-chip subtle">Confidence {suggestion.confidence || 75}</span>
                        </div>
                        <div className="executive-card-title">{suggestion.summary}</div>
                        <div className="executive-card-copy">{suggestion.whyNow || suggestion.reasonIncluded || suggestion.plan}</div>
                        <div className="executive-card-next">Next: {suggestion.nextAction || suggestion.immediateTasks?.[0] || "Review the recommendation"}</div>
                        {suggestion.evidenceBundle?.[0] && (
                          <div className="executive-card-evidence">
                            <BookOpen size={13} />
                            <span>{suggestion.evidenceBundle[0].snippet}</span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {relationshipNudges.length > 0 && (
                  <div className="home-section">
                    <div className="section-header">
                      <div className="header-title">
                        <h2>Relationship Radar</h2>
                      </div>
                      <span className="section-kicker">Signals worth acting on</span>
                    </div>
                    <div className="suggestion-list">
                      {relationshipNudges.map((suggestion) => (
                        <button
                          key={suggestion.id}
                          className={`executive-suggestion-row tone-${suggestionToneClass(suggestion.suggestionClass)}`}
                          onClick={() => setSelectedSuggestion(suggestion)}
                        >
                          <div className="executive-row-avatar"><User size={16} /></div>
                          <div className="executive-row-body">
                            <div className="executive-row-titlebar">
                              <span className="executive-row-name">{suggestion.contactName || suggestion.topic}</span>
                              <span className="executive-chip subtle">{suggestionClassLabel(suggestion.suggestionClass)}</span>
                              <span className="executive-chip subtle">Confidence {suggestion.confidence || 75}</span>
                            </div>
                            <div className="executive-row-copy">{suggestion.interpretation || suggestion.summary}</div>
                            <div className="executive-row-next">Next: {suggestion.nextAction || suggestion.impliedAction || suggestion.immediateTasks?.[0] || "Review relationship context"}</div>
                          </div>
                          <div className="executive-row-side">
                            {typeof suggestion.daysSinceLastContact === "number" ? `${suggestion.daysSinceLastContact}d` : suggestionLaneLabel(suggestion.lane)}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {keepWarmSuggestions.length > 0 && (
                  <div className="home-section">
                    <div className="section-header">
                      <div className="header-title">
                        <h2>Keep Warm</h2>
                      </div>
                      <span className="section-kicker">Strategic items to keep alive</span>
                    </div>
                    <div className="suggestion-list">
                      {keepWarmSuggestions.map((suggestion) => (
                        <button
                          key={suggestion.id}
                          className={`executive-suggestion-row tone-${suggestionToneClass(suggestion.suggestionClass)}`}
                          onClick={() => setSelectedSuggestion(suggestion)}
                        >
                          <div className="executive-row-body">
                            <div className="executive-row-titlebar">
                              <span className="executive-row-name">{suggestion.summary}</span>
                              <span className="executive-chip subtle">{suggestionClassLabel(suggestion.suggestionClass)}</span>
                            </div>
                            <div className="executive-row-copy">{suggestion.whyNow || suggestion.reasonIncluded || suggestion.plan}</div>
                            <div className="executive-row-next">Next: {suggestion.nextAction || suggestion.immediateTasks?.[0] || "Review and decide"}</div>
                          </div>
                          <div className="executive-row-side">{suggestionLaneLabel(suggestion.lane)}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}


        {/* Task Detail Popup */}
        {selectedSuggestion && (
          <div
            className="executive-modal-backdrop"
            onClick={() => setSelectedSuggestion(null)}
          >
            <div
              onClick={e => e.stopPropagation()}
              className="executive-modal-card"
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                <div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                    <span className="executive-chip">{suggestionLaneLabel(selectedSuggestion.lane)}</span>
                    <span className="executive-chip subtle">{suggestionClassLabel(selectedSuggestion.suggestionClass)}</span>
                    <span className="executive-chip subtle">Confidence {selectedSuggestion.confidence || 75}</span>
                  </div>
                  <h2 style={{ margin: '8px 0 0 0', fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em' }}>{selectedSuggestion.summary}</h2>
                  <div style={{ marginTop: '10px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    {selectedSuggestion.reasonIncluded || "Surfaced because recent evidence suggests this is worth attention now."}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedSuggestion(null)}
                  style={{ background: '#f8f9fa', border: 'none', borderRadius: '50%', width: 36, height: 36, cursor: 'pointer', fontSize: '18px', color: 'var(--text-secondary)' }}
                >×</button>
              </div>

              {(selectedSuggestion.whyNow || selectedSuggestion.nextAction) && (
                <div className="executive-focus-panel">
                  {selectedSuggestion.whyNow && (
                    <div>
                      <div className="executive-focus-label">Why now</div>
                      <div className="executive-focus-copy">{selectedSuggestion.whyNow}</div>
                    </div>
                  )}
                  {selectedSuggestion.nextAction && (
                    <div style={{ marginTop: '12px' }}>
                      <div className="executive-focus-label">Best next move</div>
                      <div className="executive-focus-next">{selectedSuggestion.nextAction}</div>
                    </div>
                  )}
                </div>
              )}

              {selectedSuggestion.interpretation && (
                <div style={{ padding: '20px', background: 'var(--accent-secondary)', borderRadius: '16px', border: '1px solid rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent-primary)', marginBottom: '8px' }}>Interpretation</div>
                  <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                    {selectedSuggestion.interpretation}
                  </div>
                  {selectedSuggestion.impliedAction && (
                    <div style={{ marginTop: '12px', fontSize: '14px', color: 'var(--accent-primary)', fontWeight: 600 }}>
                      → {selectedSuggestion.impliedAction}
                    </div>
                  )}
                </div>
              )}

              {selectedSuggestion.whyNow && !selectedSuggestion.interpretation && (
                <div style={{ padding: '16px 20px', background: '#f8f9fa', borderRadius: '16px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>Why Now</div>
                  <div style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.5 }}>{selectedSuggestion.whyNow}</div>
                </div>
              )}

              {selectedSuggestion.plan && (
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>Chief of Staff Brief</div>
                  <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: 'var(--text-primary)' }}>{selectedSuggestion.plan}</p>
                </div>
              )}

              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>Evidence</div>
                <ReceiptList receipts={selectedSuggestion.evidenceBundle} />
              </div>

              <details className="retrieval-trace-details" style={{ marginTop: '-6px' }}>
                <summary>Why this appeared</summary>
                <div className="trace-content">
                  <TraceSection label="Source Mix">
                    {(selectedSuggestion.sourceMix || ["memory"]).join(" · ")}
                  </TraceSection>
                  <TraceSection label="Priority">
                    {selectedSuggestion.priorityScore || 0} / 100
                  </TraceSection>
                  <TraceSection label="Freshness">
                    {selectedSuggestion.freshnessScore || 0} / 100
                  </TraceSection>
                  <TraceSection label="What would make this go away">
                    Dismiss it, snooze it, complete the next action, or convert it into a routine.
                  </TraceSection>
                </div>
              </details>

              {selectedSuggestion.draftMessage && (
                <div style={{ background: '#f5f3ff', color: '#6d28d9', borderRadius: '16px', padding: '20px', border: '1px solid rgba(109, 40, 217, 0.05)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '12px', opacity: 0.7 }}>Suggested Opener</div>
                  <div style={{ fontSize: '14px', lineHeight: 1.6, fontWeight: 500 }}>"{selectedSuggestion.draftMessage}"</div>
                </div>
              )}

              {selectedSuggestion.aiCompletedWork && (
                <div style={{ background: '#f0fdf4', borderRadius: '16px', padding: '20px', border: '1px solid rgba(22, 101, 52, 0.05)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#166534', marginBottom: '8px' }}>AI Prepared</div>
                  <div style={{ fontSize: '14px', lineHeight: 1.6, color: '#166534' }}>{selectedSuggestion.aiCompletedWork}</div>
                </div>
              )}


              {(() => {
                const tasks = [
                  ...(selectedSuggestion.humanTasks || []),
                  ...(selectedSuggestion.immediateTasks || [])
                ];
                if (tasks.length === 0) return null;
                const completedTasks: string[] = (selectedSuggestion as any).completedTasks || [];
                const toggleTask = async (task: string) => {
                  const newCompleted = completedTasks.includes(task)
                    ? completedTasks.filter(t => t !== task)
                    : [...completedTasks, task];
                  const allTasksForSuggestion = [
                    ...((selectedSuggestion as any).humanTasks || []),
                    ...((selectedSuggestion as any).immediateTasks || [])
                  ];
                  const isFullyCompleted = allTasksForSuggestion.length > 0 && allTasksForSuggestion.every((t: string) => newCompleted.includes(t));
                  if (isFullyCompleted) {
                    setSelectedSuggestion(null);
                    setSuggestions(prev => {
                      const next = prev.filter(s => s.id !== selectedSuggestion.id);
                      void weave?.setProactiveSuggestions(next as any);
                      return next;
                    });
                  } else {
                    const updated = { ...(selectedSuggestion as any), completedTasks: newCompleted };
                    setSelectedSuggestion(updated as any);
                    setSuggestions(prev => {
                      const next = prev.map(s => s.id === selectedSuggestion.id ? updated as any : s);
                      void weave?.setProactiveSuggestions(next as any);
                      return next;
                    });
                  }
                };
                return (
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '12px' }}>Tasks</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {tasks.map((task, i) => {
                        const done = completedTasks.includes(task);
                        return (
                          <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={done}
                              onChange={() => toggleTask(task)}
                              style={{ marginTop: '2px', width: '16px', height: '16px', accentColor: 'var(--accent-primary)', flexShrink: 0 }}
                            />
                            <span style={{
                              fontSize: '14px', lineHeight: 1.5,
                              textDecoration: done ? 'line-through' : 'none',
                              color: done ? 'var(--text-secondary)' : 'var(--text-primary)'
                            }}>{task}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Step breakdown */}
              <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '20px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  What you still need to do
                </div>
                {isLoadingTaskDetail ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--text-secondary)', padding: '12px 0' }}>
                    <RefreshCw size={14} className="spin" />
                    Breaking this down...
                  </div>
                ) : taskDetail ? (
                  <div style={{ fontSize: '14px', lineHeight: 1.7, color: 'var(--text-primary)' }}>
                    {renderContent(taskDetail)}
                  </div>
                ) : null}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                <button className="secondary-button" onClick={() => { void dismissSuggestion(selectedSuggestion); }}>
                  Dismiss
                </button>
                <button className="secondary-button" onClick={() => { void snoozeSuggestion(selectedSuggestion); }}>
                  Snooze 1 day
                </button>
                <button className="secondary-button" onClick={() => { void convertSuggestionToRoutine(selectedSuggestion); }}>
                  Convert to Routine
                </button>
                <button className="secondary-button" onClick={() => setSelectedSuggestion(null)}>Close</button>
                <button
                  className="secondary-button"
                  style={{ background: 'var(--accent-secondary)', color: 'var(--accent-primary)' }}
                  onClick={() => {
                    setInput(selectedSuggestion.draftMessage || selectedSuggestion.summary || '');
                    setSelectedSuggestion(null);
                    void startNewChat();
                    setTimeout(() => setView('chat'), 100);
                  }}
                >
                  Ask Weave about this
                </button>
              </div>
            </div>
          </div>
        )}

        {view === "chat" && (
          <div className="chat-view-wrapper">
            <aside className="chat-history-sidebar">
              <div className="chat-history-header">
                <h3>Chats</h3>
                <button className="icon-button" onClick={startNewChat} title="New Chat">
                  <MessageSquare size={16} />
                </button>
              </div>
              <div className="chat-history-list">
                {sessions?.map(s => (
                  <div 
                    key={s.id} 
                    className={`chat-history-item ${currentSessionId === s.id ? 'active' : ''}`}
                    onClick={() => {
                      setIsDraftChat(false);
                      setCurrentSessionId(s.id);
                    }}
                  >
                    <span className="chat-title">{s.title}</span>
                    <button 
                      className="delete-action"
                      onClick={(e) => { e.stopPropagation(); deleteChat(s.id, e); }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </aside>

            <div className="chat-main-container">
              {isDraftChatView ? (
                <div className="draft-chat-shell">
                  <div className="chat-onboarding draft-chat-onboarding">
                    <div className="onboarding-content">
                      <h1>{personalizedGreeting}</h1>
                      <p>I'm here to help. What's on your mind?</p>
                      <div className="onboarding-prompts">
                        {getProactivePrompts().map((p, i) => (
                          <button 
                            key={i} 
                            className="onboarding-prompt-card"
                            onClick={() => { void sendMessage(p); }}
                          >
                            <span className="onboarding-prompt-text">{p}</span>
                            <span className="onboarding-prompt-footer">Ask</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="chat-window">
                  <div className="messages-flow">
                  {messages?.map(m => (
                    <div key={m.id} className={`message-bubble ${m.role}`}>
                      <div className="bubble-header">
                        <span className="sender">{m.role === 'user' ? 'You' : 'Weave'}</span>
                        <span className="time">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      
                      {m.role === 'assistant' && m.retrievalTrace && (
                        <details className="retrieval-trace-details">
                          <summary>Thinking process...</summary>
                          <div className="trace-content">
                            <TraceSection label="Memory Focus">
                              {(m.retrievalTrace.retrievalSteps?.determineSource.strategy || "WEB")}
                            </TraceSection>
                            <TraceSection label="Filters">
                              {formatFilters(m.retrievalTrace.filters)}
                            </TraceSection>
                            {m.retrievalTrace.memoryNodes && m.retrievalTrace.memoryNodes.length > 0 && (
                              <div className="trace-nodes">
                                {m.retrievalTrace.memoryNodes.map((title: string, i: number) => (
                                  <span key={i} className="node-pill">{title}</span>
                                ))}
                              </div>
                            )}
                            <TraceSection label="Memory Receipts">
                              <ReceiptList receipts={m.retrievalTrace.evidence?.memoryReceipts} />
                            </TraceSection>
                            <TraceSection label="Raw Evidence">
                              <ReceiptList receipts={m.retrievalTrace.evidence?.rawReceipts} />
                            </TraceSection>
                            <TraceSection label="Web Sources">
                              <ReceiptList receipts={m.retrievalTrace.evidence?.webReceipts} />
                            </TraceSection>
                          </div>
                        </details>
                      )}

                      <div className="bubble-text">
                        {renderContent(m.id === typingMessageId ? typedMessageContent : m.content, (name, detail) => {
                          const node = nodes.find(n => n.title === name || n.id === detail);
                          if (node) setSelectedNodeId(node.id);
                        })}
                      </div>
                    </div>
                  ))}
                  
                  {thinkingSteps.length > 0 && (
                    <div className="message-bubble assistant thinking">
                      <div className="thinking-indicator">
                        <div className="dot"></div>
                        <div className="dot"></div>
                        <div className="dot"></div>
                        <span className="thinking-text">{thinkingSteps[thinkingSteps.length - 1]}</span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
                </div>
              )}

              <div className={`chat-input-container ${isDraftChatView ? 'draft' : ''}`}>
                <div className="input-box-refined">
                  <textarea 
                    placeholder="Type a message..." 
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    rows={1}
                  />
                  <button 
                    className={`send-button-refined ${input.trim() ? 'active' : ''}`} 
                    onClick={() => sendMessage()} 
                    disabled={isProcessing || !input.trim()}
                  >
                    <Send size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {view === "contacts" && (
          <div style={{ padding: '40px 48px', overflowY: 'auto', flex: 1 }}>
            <div style={{ marginBottom: '32px' }}>
              <h1 style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 8px 0' }}>Contacts</h1>
              <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)' }}>People and identities identified in your memory.</p>
            </div>
            
            {(() => {
              if (peopleNodes.length === 0) {
                return (
                  <div className="empty-state" style={{ height: '200px' }}>
                    No contacts identified yet. Sync Google or Apple Contacts in Settings to get started.
                  </div>
                );
              }
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
                  {peopleNodes.map(p => (
                    <div key={p.id} className="node-card" style={{ padding: '24px', cursor: 'pointer' }} onClick={() => setSelectedNodeId(p.id)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
                        <div style={{
                          width: '48px', height: '48px',
                          borderRadius: '50%',
                          background: 'var(--accent-secondary)',
                          color: 'var(--accent-primary)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                          <User size={24} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>{p.title}</h3>
                          {p.metadata?.org && <div style={{ fontSize: '13px', opacity: 0.6 }}>{p.metadata.org}</div>}
                        </div>
                        <ExternalLink size={16} style={{ opacity: 0.3 }} />
                      </div>
                      
                      {p.summary && (
                        <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
                          {p.summary}
                        </p>
                      )}
                      
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {p.metadata?.emails?.length > 0 && (
                          <div style={{ fontSize: '12px' }}>
                            <span style={{ opacity: 0.5, marginRight: '8px' }}>Email</span>
                            {p.metadata.emails[0]}
                          </div>
                        )}
                        {p.metadata?.phones?.length > 0 && (
                          <div style={{ fontSize: '12px' }}>
                            <span style={{ opacity: 0.5, marginRight: '8px' }}>Phone</span>
                            {p.metadata.phones[0]}
                          </div>
                        )}
                      </div>
                      
                      <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(0,0,0,0.04)', display: 'flex', gap: '10px' }}>
                        <button 
                          className="secondary-button" 
                          style={{ fontSize: '12px', padding: '6px 12px', flex: 1 }}
                          onClick={(e) => { e.stopPropagation(); setSelectedNodeId(p.id); }}
                        >
                          View Profile
                        </button>
                        <button 
                          className="secondary-button" 
                          style={{ fontSize: '12px', padding: '6px 12px', flex: 1 }}
                          onClick={(e) => { e.stopPropagation(); setInput(`Tell me about ${p.title}`); void startNewChat(); }}
                        >
                          Context History
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {view === "explorer" && (
          <div className="explorer-grid">
            {(!nodes || nodes.length === 0) && <div className="empty-state">No memory nodes found yet.</div>}
            {nodes?.map(n => (
              <div key={n.id} className="node-card" style={{ borderLeft: n.layer === 'EPISODE' ? '4px solid #756a5d' : 'none', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span className={`layer-badge layer-${n.layer}`}>{n.layer}</span>
                  <span style={{ fontSize: '11px', color: '#756a5d', opacity: 0.6 }}>{new Date(n.anchorAt || n.createdAt).toLocaleString()}</span>
                </div>
                <h3 style={{ margin: '0 0 10px 0', fontSize: '17px', color: '#332d28' }}>{n.title}</h3>
                <p style={{ margin: 0, fontSize: '14px', color: '#544b41', lineHeight: '1.5' }}>
                  {n.layer === 'EPISODE' ? (n.summary || n.canonicalText.slice(0, 300)) : n.summary}
                </p>
                {n.layer === 'EPISODE' && (n.canonicalText.includes("RAW EVIDENCE BULLETS:") || n.canonicalText.includes("RAW SUMMARY:")) && (
                  <div style={{ marginTop: '10px', fontSize: '12px', color: '#756a5d', background: 'rgba(117, 106, 93, 0.03)', padding: '8px', borderRadius: '4px' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '10px', textTransform: 'uppercase', marginBottom: '4px', opacity: 0.6 }}>Raw Evidence Bullets:</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {n.canonicalText.includes("RAW EVIDENCE BULLETS:")
                        ? n.canonicalText.split("RAW EVIDENCE BULLETS:")[1].split("BEHAVIORAL METADATA:")[0].trim()
                        : n.canonicalText.split("RAW SUMMARY:")[1].split("BEHAVIORAL:")[0].trim()}
                    </div>
                  </div>
                )}
                {(n.layer === 'EPISODE' || n.metadata?.app) && (
                  <div style={{ marginTop: '12px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {n.metadata.primary_project && <span className="layer-badge layer-SEMANTIC" style={{ fontSize: '10px' }}>{n.metadata.primary_project}</span>}
                    {n.metadata.vibe && <span style={{ fontSize: '10px', opacity: 0.5 }}>• {n.metadata.vibe}</span>}
                    {n.metadata.app && <span style={{ fontSize: '10px', opacity: 0.65 }}>App: {n.metadata.app}</span>}
                    {typeof n.metadata.snapshot_count === "number" && <span style={{ fontSize: '10px', opacity: 0.65 }}>Snapshots: {n.metadata.snapshot_count}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {view === "routines" && (
          <div className="executive-dashboard">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
              <div>
                <h1 style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 8px 0' }}>Routines</h1>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)' }}>
                  Save assistant playbooks, schedule them deliberately, and keep a history of generated briefings with receipts.
                </p>
              </div>
              <button className="primary-button" onClick={() => openRoutineEditor({ kind: "custom", cadence: "manual" })}>
                New Routine
              </button>
            </div>

            <div className="executive-summary-grid">
              <div className="executive-summary-card">
                <div className="executive-summary-label"><Calendar size={14} /> Active Routines</div>
                <div className="executive-summary-value">{routines.filter((routine) => routine.enabled).length}</div>
                <div className="executive-summary-meta">{routines.length} total saved playbooks</div>
              </div>
              <div className="executive-summary-card">
                <div className="executive-summary-label"><Clock3 size={14} /> Next Run</div>
                <div className="executive-summary-value">{nextRoutineRuns[0]?.routine.title || "None scheduled"}</div>
                <div className="executive-summary-meta">{nextRoutineRuns[0]?.nextRunAt ? formatStatusTimestamp(nextRoutineRuns[0].nextRunAt) : "Manual routines only"}</div>
              </div>
              <div className="executive-summary-card">
                <div className="executive-summary-label"><BookOpen size={14} /> Recent Outputs</div>
                <div className="executive-summary-value">{routineRuns.length}</div>
                <div className="executive-summary-meta">Saved briefings and run history</div>
              </div>
            </div>

            <div className="settings-section">
              <h3>Templates</h3>
              <div className="suggestion-card-grid">
                {routineTemplates.map((template) => (
                  <div key={template.id} className="executive-suggestion-card tone-soft" style={{ cursor: 'default' }}>
                    <div className="executive-card-topline">
                      <span className="executive-chip">{template.defaultCadence}</span>
                      <span className="executive-chip subtle">{template.defaultTimeOfDay || "Any time"}</span>
                    </div>
                    <div className="executive-card-title">{template.title}</div>
                    <div className="executive-card-copy">{template.description}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
                      {template.defaultCadence} {template.defaultTimeOfDay ? `· ${template.defaultTimeOfDay}` : ""}
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => openRoutineEditor({
                        templateId: template.id,
                        kind: "template",
                        title: template.title,
                        description: template.description,
                        prompt: template.prompt,
                        cadence: template.defaultCadence,
                        timeOfDay: template.defaultTimeOfDay,
                        sources: template.sources
                      })}
                    >
                      Use Template
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <h3>Saved Routines</h3>
              {routines.length === 0 ? (
                <div className="empty-state" style={{ height: '140px' }}>No routines yet. Start from a template or create a custom one.</div>
              ) : (
                <div className="suggestion-card-grid">
                  {routines.map((routine) => (
                    <div key={routine.id} className="executive-suggestion-card tone-neutral" style={{ background: selectedRoutineId === routine.id ? 'var(--accent-secondary)' : '#fff', cursor: 'default' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                        <div>
                          <div className="executive-card-title" style={{ fontSize: '17px', marginBottom: '8px' }}>{routine.title}</div>
                          <div className="executive-card-topline">
                            <span className="executive-chip">{routine.enabled ? 'Enabled' : 'Disabled'}</span>
                            <span className="executive-chip subtle">{routine.cadence}</span>
                            {routine.timeOfDay && <span className="executive-chip subtle">{routine.timeOfDay}</span>}
                            {computeNextRoutineRun(routine) && <span className="executive-chip subtle">Next {formatStatusTimestamp(computeNextRoutineRun(routine) || undefined)}</span>}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '10px' }}>
                            Sources: {[
                              routine.sources.memory && "memory",
                              routine.sources.calendar && "calendar",
                              routine.sources.contacts && "contacts",
                              routine.sources.web && "web"
                            ].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <button className="secondary-button" style={{ padding: '6px 10px', fontSize: '12px' }} onClick={() => setSelectedRoutineId(routine.id)}>
                          View
                        </button>
                      </div>
                      {routine.description && (
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: '10px' }}>{routine.description}</div>
                      )}
                      {routine.lastRunAt && (
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '12px' }}>
                          Last run {formatStatusTimestamp(routine.lastRunAt)}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
                        <button className="secondary-button" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => openRoutineEditor(routine)}>
                          Edit
                        </button>
                        <button className="secondary-button" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={() => { void runRoutineNow(routine.id); }} disabled={isRunningRoutineId === routine.id}>
                          {isRunningRoutineId === routine.id ? 'Running...' : 'Run Now'}
                        </button>
                        <button className="secondary-button" style={{ padding: '8px 12px', fontSize: '12px' }} onClick={async () => {
                          await weave.deleteRoutine(routine.id);
                          if (selectedRoutineId === routine.id) setSelectedRoutineId(null);
                          await refreshRoutines();
                        }}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-section">
              <h3>{selectedRoutine ? `${selectedRoutine.title} History` : 'Recent Routine Runs'}</h3>
              {selectedRoutineRuns.length === 0 ? (
                <div className="empty-state" style={{ height: '140px' }}>No routine runs yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {selectedRoutineRuns.slice(0, 10).map((run) => (
                    <div key={run.id} className="executive-run-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '15px' }}>{run.title}</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>{formatStatusTimestamp(run.createdAt)} · Saved briefing</div>
                        </div>
                      </div>
                      <div style={{ marginTop: '14px', fontSize: '14px', lineHeight: 1.7 }}>
                        {renderContent(run.content)}
                      </div>
                      <div style={{ marginTop: '14px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>Receipts</div>
                        <ReceiptList receipts={run.receipts} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {editingRoutine && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }} onClick={() => setEditingRoutine(null)}>
                <div style={{ width: 'min(760px, 92vw)', maxHeight: '86vh', overflowY: 'auto', background: '#fff', borderRadius: '24px', padding: '28px', boxShadow: '0 24px 80px rgba(0,0,0,0.18)' }} onClick={(e) => e.stopPropagation()}>
                  <h2 style={{ marginTop: 0 }}>{editingRoutine.id ? 'Edit Routine' : 'New Routine'}</h2>
                  <div style={{ display: 'grid', gap: '14px' }}>
                    <input className="settings-input" value={editingRoutine.title || ""} placeholder="Routine title" onChange={(e) => setEditingRoutine((prev) => ({ ...(prev || {}), title: e.target.value }))} />
                    <input className="settings-input" value={editingRoutine.description || ""} placeholder="Short description" onChange={(e) => setEditingRoutine((prev) => ({ ...(prev || {}), description: e.target.value }))} />
                    <textarea className="settings-input settings-textarea" value={editingRoutine.prompt || ""} placeholder="Routine prompt" onChange={(e) => setEditingRoutine((prev) => ({ ...(prev || {}), prompt: e.target.value }))} />
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
                      <select className="settings-input" value={editingRoutine.cadence || "manual"} onChange={(e) => setEditingRoutine((prev) => ({ ...(prev || {}), cadence: e.target.value as RoutineDefinition["cadence"] }))}>
                        <option value="manual">manual</option>
                        <option value="daily">daily</option>
                        <option value="weekdays">weekdays</option>
                        <option value="weekly">weekly</option>
                      </select>
                      <input className="settings-input" value={editingRoutine.timeOfDay || ""} placeholder="08:00" onChange={(e) => setEditingRoutine((prev) => ({ ...(prev || {}), timeOfDay: e.target.value }))} />
                      <input className="settings-input" value={editingRoutine.tone || ""} placeholder="Tone" onChange={(e) => setEditingRoutine((prev) => ({ ...(prev || {}), tone: e.target.value }))} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px' }}>
                      {(["memory", "calendar", "contacts", "web"] as const).map((key) => (
                        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                          <input
                            type="checkbox"
                            checked={editingRoutine.sources?.[key] ?? false}
                            onChange={(e) => setEditingRoutine((prev) => ({
                              ...(prev || {}),
                              sources: {
                                memory: prev?.sources?.memory ?? true,
                                calendar: prev?.sources?.calendar ?? true,
                                contacts: prev?.sources?.contacts ?? false,
                                web: prev?.sources?.web ?? true,
                                [key]: e.target.checked
                              }
                            }))}
                          />
                          {key}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                    <button className="secondary-button" onClick={() => setEditingRoutine(null)}>Cancel</button>
                    <button className="primary-button" onClick={() => { void saveRoutineDraft(); }}>Save Routine</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {view === "settings" && (
          <div className="settings-container" style={{ overflowY: 'auto', flex: 1 }}>

            <div style={{ marginBottom: '40px' }}>
              <h1 style={{ fontSize: '32px', fontWeight: 800, letterSpacing: '-0.03em' }}>Settings</h1>
              <p style={{ color: 'var(--text-secondary)', marginTop: '-12px' }}>Configure your memory graph and privacy controls.</p>
            </div>

            <div className="settings-section">
              <h3>Account & Integrations</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ padding: '20px', background: 'rgba(0,0,0,0.02)', borderRadius: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
                    <div style={{ width: '48px', height: '48px', borderRadius: '24px', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {supabaseUser?.user_metadata?.avatar_url ? (
                        <img src={supabaseUser.user_metadata.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <User size={24} color="white" />
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '16px' }}>{supabaseUser?.user_metadata?.full_name || supabaseUser?.email}</div>
                      <div style={{ fontSize: '13px', opacity: 0.6 }}>{supabaseUser?.email}</div>
                    </div>
                    <button className="secondary-button" onClick={logout} style={{ height: '36px', fontSize: '13px' }}>Sign Out</button>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', padding: '10px 14px', background: '#fff', borderRadius: '10px', border: '1px solid rgba(0,0,0,0.03)' }}>
                    <strong>Local Isolation:</strong> Active. Your memory graph is securely locked to this account on this machine.
                  </div>
                </div>

                <div style={{ padding: '20px', background: google.connected ? 'rgba(0,122,255,0.03)' : 'rgba(0,0,0,0.01)', borderRadius: '16px', border: google.connected ? '1px solid rgba(0,122,255,0.1)' : '1px solid transparent' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '15px' }}>Google Memory Sync</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>Auto-syncs Calendar, Mail, and Contacts every 5m.</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>
                        Last sync: {formatLastSync(google.lastSyncAt)}
                      </div>
                    </div>
                    {google.connected ? (
                      <span style={{ fontSize: '10px', background: '#dcfce7', color: '#15803d', padding: '4px 12px', borderRadius: '12px', fontWeight: 800 }}>ACTIVE</span>
                    ) : (
                      <span style={{ fontSize: '10px', background: '#f4f4f7', color: '#756a5d', padding: '4px 12px', borderRadius: '12px', fontWeight: 800 }}>READY</span>
                    )}
                  </div>
                  
                  {google.connected ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 500, opacity: 0.8 }}>{google.email}</div>
                      <div style={{ display: 'flex', gap: '12px' }}>
                        <button className="secondary-button" onClick={() => weave.syncGoogle()} style={{ height: '32px', fontSize: '12px' }}>
                          Sync Now
                        </button>
                        <button className="secondary-button" onClick={() => weave.startGoogleAuth()} style={{ height: '32px', fontSize: '12px' }}>Reconnect</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                      <button 
                        className="primary-button" 
                        onClick={() => weave.startGoogleAuth()} 
                        style={{ flex: 1, height: '44px', fontSize: '14px', background: 'var(--accent-primary)', color: '#fff' }}
                      >
                        Connect Google for Sync
                      </button>
                    </div>
                  )}
                  {google.error && <div style={{ marginTop: '12px', fontSize: '12px', color: '#be123c', padding: '10px', background: '#fff1f2', borderRadius: '8px' }}>{google.error}</div>}
                </div>

                <div style={{ padding: '20px', background: 'rgba(0,0,0,0.01)', borderRadius: '16px', border: '1px solid rgba(0,0,0,0.04)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '15px' }}>Apple Contacts</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Import contacts from the Apple ecosystem into your local memory graph.
                      </div>
                    </div>
                    <button 
                      className="secondary-button" 
                      onClick={async () => {
                        setSettingsStatus("Syncing Apple Contacts...");
                        try {
                          await weave.syncAppleContacts();
                          setSettingsStatus("Apple Contacts synced successfully.");
                        } catch (e: any) {
                          setSettingsStatus(`Apple Contacts sync failed: ${e.message}`);
                        }
                      }}
                      style={{ height: '36px', fontSize: '12px', flexShrink: 0 }}
                    >
                      Sync Apple Contacts
                    </button>
                  </div>
                </div>

                <div style={{ padding: '20px', background: 'rgba(0,0,0,0.01)', borderRadius: '16px', border: '1px solid rgba(0,0,0,0.04)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '15px' }}>External Contact Research</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px', maxWidth: '520px' }}>
                        When enabled, Weave may send contact names, organization hints, and relationship context to external web and AI services to enrich contact profiles.
                      </div>
                    </div>
                    <button
                      className={settings?.externalContactResearchAllowed ? "secondary-button" : "primary-button"}
                      style={{ height: '36px', fontSize: '12px', flexShrink: 0 }}
                      onClick={async () => {
                        const enabled = !!settings?.externalContactResearchAllowed;
                        if (!enabled) {
                          const confirmed = confirm("Allow off-device contact research for this account? This may send contact names, organization hints, and relationship context to external services.");
                          if (!confirmed) return;
                        }
                        const next = await weave.updateSettings({ externalContactResearchAllowed: !enabled });
                        setSettings(next);
                      }}
                    >
                      {settings?.externalContactResearchAllowed ? "Disable External Research" : "Enable External Research"}
                    </button>
                  </div>
                </div>

                <div style={{ padding: '20px', background: settings?.rawCloudAllowed ? 'rgba(0,122,255,0.03)' : 'rgba(0,0,0,0.01)', borderRadius: '16px', border: settings?.rawCloudAllowed ? '1px solid rgba(0,122,255,0.1)' : '1px solid rgba(0,0,0,0.04)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                    <div style={{ maxWidth: '560px' }}>
                      <div style={{ fontWeight: 700, fontSize: '15px' }}>Cloud & Remote Access</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Allow Weave to expose this signed-in account through the built-in remote MCP HTTP service so ChatGPT or Claude can connect through your own HTTPS domain or tunnel.
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '10px', lineHeight: 1.55 }}>
                        This does not publish your data by itself. When enabled, Weave starts the MCP HTTP service automatically for the active signed-in account. Remote requests are authenticated with Supabase session tokens and are restricted to this account.
                      </div>
                      <div style={{ marginTop: '12px', padding: '12px 14px', borderRadius: '12px', background: publicMcpReady ? 'rgba(34,197,94,0.08)' : '#fff7ed', border: publicMcpReady ? '1px solid rgba(34,197,94,0.16)' : '1px solid rgba(249,115,22,0.16)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Remote MCP readiness</div>
                        <div>{publicMcpReady ? "Ready: a real public HTTPS MCP URL is configured for connectors." : "Not ready: Claude web and ChatGPT web cannot connect to localhost. You must provide a real public HTTPS MCP URL."}</div>
                      </div>
                      <div style={{ marginTop: '12px', padding: '12px 14px', borderRadius: '12px', background: '#f8f9fb', border: '1px solid rgba(0,0,0,0.05)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>Supabase requirement</div>
                        <div>No Supabase migrations are needed for the current setup. Weave is only using Supabase Auth to verify the signed-in user for remote MCP access.</div>
                      </div>
                      <div style={{ marginTop: '12px', padding: '12px 14px', borderRadius: '12px', background: '#fff', border: '1px solid rgba(0,0,0,0.05)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                        <div><strong>Local MCP endpoint:</strong> <code>http://localhost:8787/mcp</code></div>
                        <div style={{ marginTop: '6px' }}><strong>Auth:</strong> Supabase bearer token for the signed-in user</div>
                        <div style={{ marginTop: '6px' }}><strong>Connector URL:</strong> {settings?.publicMcpUrl ? <code>{settings.publicMcpUrl}</code> : <>your public HTTPS endpoint pointing at <code>/mcp</code></>}</div>
                      </div>
                      <div style={{ marginTop: '12px', padding: '12px 14px', borderRadius: '12px', background: '#fff', border: '1px solid rgba(0,0,0,0.05)' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '12px', marginBottom: '8px' }}>Public MCP URL</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: '10px' }}>
                          Paste the real public HTTPS URL that forwards to this machine’s MCP endpoint. Example: <code>https://weave.yourdomain.com/mcp</code>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                          <input
                            value={publicMcpUrlDraft}
                            onChange={(event) => setPublicMcpUrlDraft(event.target.value)}
                            placeholder="https://weave.yourdomain.com/mcp"
                            style={{ flex: '1 1 320px', minWidth: '260px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(0,0,0,0.08)', background: '#fff', color: 'var(--text-primary)', fontSize: '12px' }}
                          />
                          <button
                            className="secondary-button"
                            style={{ height: '34px', fontSize: '12px' }}
                            onClick={async () => {
                              const trimmed = publicMcpUrlDraft.trim();
                              if (trimmed && !/^https:\/\//i.test(trimmed)) {
                                setSettingsStatus("Public MCP URL must start with https://");
                                return;
                              }
                              const next = await weave.updateSettings({ publicMcpUrl: trimmed });
                              setSettings(next);
                              setSettingsStatus(trimmed ? "Public MCP URL saved." : "Public MCP URL cleared.");
                            }}
                          >
                            Save URL
                          </button>
                        </div>
                      </div>
                      <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div style={{ padding: '12px 14px', borderRadius: '12px', background: '#fff', border: '1px solid rgba(0,0,0,0.05)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Connect ChatGPT</div>
                          <div>1. Enable Cloud Access here while signed into the correct Weave account.</div>
                          <div>2. Leave Weave running. The app serves <code>localhost:8787/mcp</code> automatically.</div>
                          <div>3. Put that endpoint behind a real public HTTPS URL and save it above.</div>
                          <div>4. In ChatGPT, open <strong>Settings → Apps</strong>.</div>
                          <div>5. Enable developer mode if ChatGPT requires it for custom MCP connectors.</div>
                          <div>6. Add a custom MCP connector pointing to the saved public HTTPS URL.</div>
                          <div>7. Authenticate with the same Supabase account used in Weave.</div>
                        </div>
                        <div style={{ padding: '12px 14px', borderRadius: '12px', background: '#fff', border: '1px solid rgba(0,0,0,0.05)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Connect Claude</div>
                          <div>1. Enable Cloud Access here while signed into the correct Weave account.</div>
                          <div>2. Leave Weave running so the built-in MCP endpoint stays available.</div>
                          <div>3. Put the endpoint behind a real public HTTPS URL and save it above.</div>
                          <div>4. In Claude, open <strong>Customize → Connectors</strong>.</div>
                          <div>5. Add a custom connector pointing to that saved URL ending in <code>/mcp</code>.</div>
                          <div>6. Authenticate with the same Supabase account used in Weave.</div>
                        </div>
                      </div>
                    </div>
                    <button
                      className={settings?.rawCloudAllowed ? "secondary-button" : "primary-button"}
                      style={{ height: '36px', fontSize: '12px', flexShrink: 0 }}
                      onClick={async () => {
                        const enabled = !!settings?.rawCloudAllowed;
                        if (!enabled) {
                          const confirmed = confirm("Enable cloud and remote MCP access for this account? Weave will serve the local MCP endpoint automatically, but ChatGPT and Claude web still require a real public HTTPS URL in front of it.");
                          if (!confirmed) return;
                        }
                        const next = await weave.updateSettings({ rawCloudAllowed: !enabled });
                        setSettings(next);
                        setSettingsStatus(!enabled ? "Cloud access enabled. Weave is now serving the Supabase-authenticated local MCP endpoint for this signed-in account." : "Cloud and remote MCP access disabled.");
                      }}
                    >
                      {settings?.rawCloudAllowed ? "Disable Cloud Access" : "Enable Cloud Access"}
                    </button>
                  </div>
                </div>
              </div>
            </div>





            <div className="settings-section">
              <h3>Permissions</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Weave needs the following macOS permissions to function correctly.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {[
                  {
                    key: "screen" as const,
                    label: "Screen Recording",
                    description: "Required to capture on-screen context for memory.",
                    status: (permissions?.screen ?? "unknown") as PermissionStatusValue,
                    granted: permissions?.screen === "granted",
                    detail: permissions?.screenLastVerifiedAt
                      ? `Last verified capture: ${formatStatusTimestamp(permissions.screenLastVerifiedAt)}`
                      : permissions?.screenLastError || "Run a capture test to verify screenshot access.",
                  },
                  {
                    key: "accessibility" as const,
                    label: "Accessibility",
                    description: "Required to read active window titles and app names.",
                    status: (permissions?.accessibility === true ? "granted" : permissions?.accessibility === false ? "denied" : "unknown") as PermissionStatusValue,
                    granted: permissions?.accessibility === true,
                    detail: permissions?.accessibility === true
                      ? "macOS accessibility access is enabled."
                      : "Enable this in System Settings if app names or window titles are missing.",
                  },
                  {
                    key: "contacts" as const,
                    label: "Contacts",
                    description: "Required to sync your Apple Contacts for relationship intelligence.",
                    status: (permissions?.contacts ?? "unknown") as PermissionStatusValue,
                    granted: permissions?.contacts === "granted",
                    detail: permissions?.contactsLastVerifiedAt
                      ? `Last successful Contacts access: ${formatStatusTimestamp(permissions.contactsLastVerifiedAt)}`
                      : permissions?.contactsLastError || "No Contacts access has been verified yet.",
                  },
                ].map(({ key, label, description, status, granted, detail }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 16px', borderRadius: '14px', background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.04)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '14px' }}>{label}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{description}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px' }}>{detail}</div>
                    </div>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '3px 10px',
                      borderRadius: '20px',
                      whiteSpace: 'nowrap',
                      background: granted ? 'rgba(52,199,89,0.12)' : status === "denied" ? 'rgba(255,59,48,0.1)' : 'rgba(0,0,0,0.06)',
                      color: granted ? '#1a7f37' : status === "denied" ? '#c0392b' : 'var(--text-secondary)',
                    }}>
                      {permissionLabel(status)}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                      {key === "screen" && (
                        <button
                          className="secondary-button"
                          style={{ height: '32px', fontSize: '12px', whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            try {
                              const nextCapture = await weave.runCaptureNow();
                              setCapture(nextCapture || emptyCapture);
                              const nextPermissions = await weave.getPermissions();
                              setPermissions(nextPermissions);
                              if (nextCapture?.lastCaptureAt) {
                                setSettingsStatus(`Screen capture verified at ${formatStatusTimestamp(nextCapture.lastCaptureAt)}.`);
                              } else if (nextCapture?.lastError) {
                                setSettingsStatus(`Capture test failed: ${nextCapture.lastError}`);
                              }
                            } catch (error: any) {
                              setSettingsStatus(`Capture test failed: ${error?.message || "Unknown error"}`);
                            }
                          }}
                        >
                          Test Capture
                        </button>
                      )}
                      {!granted && (
                        <button
                          className="secondary-button"
                          style={{ height: '32px', fontSize: '12px', whiteSpace: 'nowrap' }}
                          onClick={() => weave.openPermission(key)}
                        >
                          Open Settings
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <h3>Privacy & Blacklist</h3>
              <div className="settings-row">
                <label>Blacklisted Applications</label>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Weave will never capture or index content from these apps. Sensitive defaults are already included; add one per line.
                </p>
                <textarea 
                  className="settings-input settings-textarea"
                  defaultValue={settings?.blacklistedApps?.join('\n')}
                  placeholder="e.g. Keychain Access"
                  onBlur={(e) => weave.updateSettings({ blacklistedApps: e.target.value.split('\n') })}
                />
              </div>
              <div className="settings-row">
                <label>Blacklisted Websites</label>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  URLs containing these terms will be ignored. Sensitive defaults are already included; add one per line.
                </p>
                <textarea 
                  className="settings-input settings-textarea"
                  defaultValue={settings?.blacklistedWebsites?.join('\n')}
                  placeholder="e.g. bank.com"
                  onBlur={(e) => weave.updateSettings({ blacklistedWebsites: e.target.value.split('\n') })}
                />
              </div>
            </div>

            {syncProgress && (
              <div className="settings-section">
                <div style={{ marginTop: '20px', padding: '16px', background: 'var(--accent-secondary)', borderRadius: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', fontWeight: 700, color: 'var(--accent-primary)' }}>
                    <span>{syncProgress.status === 'syncing' ? `Syncing ${syncProgress.service}...` : 'Completed'}</span>
                    <span>{syncProgress.processed} / {syncProgress.total || '?'}</span>
                  </div>
                  <div style={{ height: '6px', background: 'rgba(0,122,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${(syncProgress.processed / (syncProgress.total || 1)) * 100}%`, height: '100%', background: 'var(--accent-primary)', transition: 'width 0.3s ease' }} />
                  </div>
                </div>
              </div>
            )}

            <div className="settings-section">
              <h3>System Health</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                {([
                  ["capture", "Capture"],
                  ["googleSync", "Google Sync"],
                  ["appleContacts", "Apple Contacts"]
                ] as const).map(([key, label]) => {
                  const status = key === "capture"
                    ? {
                        ...(settings?.subsystemHealth?.capture || {}),
                        lastSuccessAt: capture?.lastCaptureAt || settings?.subsystemHealth?.capture?.lastSuccessAt,
                        lastOcrAt: capture?.lastOcrAt || settings?.subsystemHealth?.capture?.lastOcrAt,
                        lastIndexedAt: capture?.lastIndexedAt || settings?.subsystemHealth?.capture?.lastIndexedAt,
                        cadenceStatus: capture?.cadenceStatus || settings?.subsystemHealth?.capture?.cadenceStatus,
                        lastFailureMessage: capture?.lastError || settings?.subsystemHealth?.capture?.lastFailureMessage
                      }
                    : settings?.subsystemHealth?.[key];
                  return (
                    <div key={key} style={{ padding: '16px', borderRadius: '14px', background: '#fff', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{label}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        <div>Last success: {formatStatusTimestamp(status?.lastSuccessAt)}</div>
                        {key === "capture" && (
                          <>
                            <div>Last OCR: {formatStatusTimestamp((status as any)?.lastOcrAt)}</div>
                            <div>Last indexed snapshot: {formatStatusTimestamp((status as any)?.lastIndexedAt)}</div>
                            <div>Cadence: {(status as any)?.cadenceStatus || 'unknown'}</div>
                            <div>Queue depth: {(status as any)?.queueDepth ?? 0}</div>
                            <div>Index queue: {(status as any)?.indexQueueDepth ?? 0}</div>
                            <div>Synthesis queue: {(status as any)?.synthesisQueueDepth ?? 0}</div>
                            <div>Skipped ticks: {(status as any)?.skippedTicks ?? 0}</div>
                            <div>Capture lag: {typeof (status as any)?.captureLagMs === "number" ? `${Math.round((status as any).captureLagMs / 1000)}s` : 'unknown'}</div>
                            <div>OCR duration: {typeof (status as any)?.ocrDurationMs === "number" ? `${Math.round((status as any).ocrDurationMs)}ms` : 'unknown'}</div>
                            <div>Capture duration: {typeof (status as any)?.captureDurationMs === "number" ? `${Math.round((status as any).captureDurationMs)}ms` : 'unknown'}</div>
                            <div>Last proactive run: {typeof (status as any)?.lastProactiveDurationMs === "number" ? `${Math.round((status as any).lastProactiveDurationMs)}ms` : 'unknown'}</div>
                            <div>Last routine run: {typeof (status as any)?.lastRoutineDurationMs === "number" ? `${Math.round((status as any).lastRoutineDurationMs)}ms` : 'unknown'}</div>
                            <div>Last Google sync: {typeof (status as any)?.lastGoogleSyncDurationMs === "number" ? `${Math.round((status as any).lastGoogleSyncDurationMs)}ms` : 'unknown'}</div>
                            {(status as any)?.retrievalCoverage && (
                              <div>Coverage: {(status as any).retrievalCoverage}</div>
                            )}
                          </>
                        )}
                        <div>Last failure: {formatStatusTimestamp(status?.lastFailureAt)}</div>
                        <div>Last error: {status?.lastFailureMessage || 'None'}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="settings-section" style={{ border: '1px solid #fee2e2' }}>
              <h3 style={{ color: '#dc2626' }}>Danger Zone</h3>
              <div className="settings-row">
                <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                  This will permanently delete memory, chat, sync cache, and credentials for the current account on this machine.
                </p>
                <button 
                  className="secondary-button" 
                  style={{ color: '#dc2626', borderColor: '#fee2e2', background: '#fff' }}
                  onClick={() => {
                    if (confirm("Delete all local data for the current account? This action is permanent.")) {
                      weave.deleteAllData().then(() => {
                        window.location.reload();
                      });
                    }
                  }}
                >
                  Delete Current Account Data
                </button>
              </div>
            </div>
            
            {settingsStatus && <p style={{ fontSize: '14px', textAlign: 'center', color: 'var(--text-secondary)' }}>{settingsStatus}</p>}
          </div>
        )}

      </main>

      <nav className="floating-navbar-pill">
        <button className={`nav-pill-item ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}>
          <Activity size={20} />
          <span>Home</span>
        </button>
        <button className={`nav-pill-item ${view === 'contacts' ? 'active' : ''}`} onClick={() => setView('contacts')}>
          <User size={20} />
          <span>Contacts</span>
        </button>
        <button className={`nav-pill-item ${view === 'routines' ? 'active' : ''}`} onClick={() => setView('routines')}>
          <Calendar size={20} />
          <span>Routines</span>
        </button>
        <button className={`nav-pill-item ${view === 'chat' ? 'active' : ''}`} onClick={goToChat}>
          <MessageSquare size={20} />
          <span>Chat</span>
        </button>

        <button className={`nav-pill-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
          <Settings size={20} />
          <span>Settings</span>
        </button>

      </nav>

      {selectedNodeId && (
        <ContactModal 
          nodeId={selectedNodeId} 
          nodes={nodes} 
          onClose={() => setSelectedNodeId(null)}
          setInput={setInput}
          startNewChat={startNewChat}
          setView={setView}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 2s linear infinite; }
      `}</style>
    </div>
  );
}

function ContactModal({ nodeId, nodes, onClose, setInput, startNewChat, setView }: { nodeId: string, nodes: any[], onClose: () => void, setInput: (v: string) => void, startNewChat: () => void, setView: (v: any) => void }) {
  const p = nodes.find(n => n.id === nodeId);
  if (!p) return null;
  const profilePic = p.metadata?.profilePic;
  const professionalSummary = p.metadata?.professionalSummary || p.summary;
  const researchSummary = p.metadata?.researchSummary;

  return (
    <div 
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, backdropFilter: 'blur(8px)'
      }}
      onClick={onClose}
    >
      <div 
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: '32px', padding: '40px',
          maxWidth: '640px', width: '90%', maxHeight: '85vh', overflowY: 'auto',
          boxShadow: '0 32px 100px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', gap: '32px'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <div style={{
              width: '80px', height: '80px',
              borderRadius: '24px',
              background: 'var(--accent-secondary)',
              color: 'var(--accent-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden', border: '1px solid var(--border-subtle)'
            }}>
              {profilePic ? (
                <img src={profilePic} alt={p.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <User size={40} />
              )}
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '28px', fontWeight: 800, letterSpacing: '-0.03em' }}>{p.title}</h2>
              {p.metadata?.org && (
                <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '2px' }}>
                  {p.metadata.org}
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: '#f4f4f7', border: 'none', width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-secondary)' }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-secondary)', marginBottom: '12px', opacity: 0.7 }}>Who they are</div>
            <p style={{ margin: 0, fontSize: '17px', lineHeight: 1.6, color: 'var(--text-primary)', fontWeight: 500 }}>
              {professionalSummary}
            </p>
          </div>

          {researchSummary && (
            <div style={{ padding: '24px', background: '#f8f9fb', borderRadius: '24px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--accent-primary)', marginBottom: '12px' }}>Contextual Insight</div>
              <div style={{ fontSize: '15px', lineHeight: 1.7, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                {renderContent(researchSummary)}
              </div>
            </div>
          )}

          {p.metadata?.localEnrichment && (
            <div style={{ padding: '16px 20px', background: 'var(--accent-secondary)', color: 'var(--accent-primary)', borderRadius: '16px', fontSize: '14px', fontWeight: 600 }}>
              {p.metadata.localEnrichment}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-secondary)', opacity: 0.7 }}>Contact Information</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {p.metadata?.emails?.map((e: string) => (
              <div key={e} style={{ fontSize: '14px', background: '#f4f4f7', padding: '8px 14px', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span style={{ opacity: 0.4 }}>Email</span> {e}
              </div>
            ))}
            {p.metadata?.phones?.map((ph: string) => (
              <div key={ph} style={{ fontSize: '14px', background: '#f4f4f7', padding: '8px 14px', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span style={{ opacity: 0.4 }}>Phone</span> {ph}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
          <button 
            className="primary-button" 
            style={{ flex: 1, height: '52px', borderRadius: '16px' }}
            onClick={() => { setInput(`Tell me about my recent interactions with ${p.title}`); void startNewChat(); onClose(); setView('chat'); }}
          >
            Context History
          </button>
          <button 
            className="secondary-button"
            style={{ flex: 1, height: '52px', borderRadius: '16px' }}
            onClick={() => { setInput(`Draft a follow-up email to ${p.title} about our last conversation`); void startNewChat(); onClose(); setView('chat'); }}
          >
            Draft Reach-out
          </button>
        </div>
      </div>
    </div>
  );
}
