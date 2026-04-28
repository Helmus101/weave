import { useEffect, useMemo, useState, useRef } from "react";
import type { ReactNode } from "react";
import { supabase } from "./lib/supabase";
import type { User as SupabaseUser } from "@supabase/supabase-js";

import {
  Activity,
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
  ProactiveSuggestion,
  SyncProgress
} from "../shared/types";
import "./styles.css";
import logo from "./assets/logo.svg";

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
    let processed = line;
    const processInline = (text: string) => {
      // Bold
      const boldParts = text.split(/\*\*(.*?)\*\*/g);
      return boldParts.map((part, j) => {
        if (j % 2 === 1) return <strong key={j} style={{ fontWeight: '700' }}>{part}</strong>;
        
        // Contacts: @Contact[Name](detail)
        const contactRegex = /@Contact\[(.*?)\]\((.*?)\)/g;
        const contactParts = part.split(contactRegex);
        if (contactParts.length > 1) {
          const result: ReactNode[] = [];
          for (let k = 0; k < contactParts.length; k++) {
            if (k % 3 === 1) {
              const name = contactParts[k];
              const detail = contactParts[k + 1];
              result.push(
                <span key={`contact-${k}`} className="contact-tag" style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  padding: '2px 10px', background: 'var(--accent-secondary)',
                  color: 'var(--accent-primary)', borderRadius: '14px',
                  fontSize: '0.9em', fontWeight: '600', cursor: 'pointer', margin: '0 2px',
                  boxShadow: '0 1px 3px rgba(66, 133, 244, 0.1)',
                  transition: 'all 0.2s ease'
                }} onClick={() => onContactClick?.(name, detail)}>
                  <User size={12} /> {name}
                </span>
              );
            } else if (k % 3 === 0) {
              result.push(contactParts[k]);
            }
          }
          return result;
        }
        return part;
      });
    };

    // Bullet points
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      blocks.push(
        <div key={i} style={{ marginLeft: '12px', marginBottom: '8px', display: 'flex', alignItems: 'flex-start' }}>
          <span style={{ marginRight: '10px', color: 'var(--accent-primary)', fontWeight: 'bold' }}>•</span>
          <span style={{ flex: 1, lineHeight: '1.6' }}>{processInline(line.substring(2))}</span>
        </div>
      );
      continue;
    }

    // Regular Paragraph
    if (trimmed === '') {
      blocks.push(<div key={i} style={{ height: '16px' }} />);
    } else {
      blocks.push(<div key={i} style={{ marginBottom: '14px', lineHeight: '1.7' }}>{processInline(line)}</div>);
    }
  }

  // Final table flush
  if (isTable) {
    const table = flushTable(lines.length);
    if (table) blocks.push(table);
  }

  return <div className="rendered-content">{blocks}</div>;
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

export default function App() {
  const weave = (window as any).weave;
  
  const [isReady, setIsReady] = useState(false);
  const [view, setView] = useState<"home" | "chat" | "settings" | "explorer" | "contacts">("home");
  const [supabaseUser, setSupabaseUser] = useState<SupabaseUser | null>(null);
  const lastSwitchedUserId = useRef<string | null>(null);
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);


  const [capture, setCapture] = useState<CaptureState>(emptyCapture);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [isDraftChat, setIsDraftChat] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [settings, setSettings] = useState<AppSettings>();
  const [google, setGoogle] = useState<GoogleAuthStatus>({ connected: false });
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [settingsStatus, setSettingsStatus] = useState<string>("");
  const [selectedSuggestion, setSelectedSuggestion] = useState<ProactiveSuggestion | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
  const [typedMessageContent, setTypedMessageContent] = useState("");
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastCaptureUpdateAtRef = useRef(0);
  const lastNodesFetchAtRef = useRef(0);
  const currentSessionIdRef = useRef<string | undefined>(undefined);

  const relationshipNudges = useMemo(
    () => (suggestions || [])
      .filter((s) => s.category === "relationship")
      .slice(0, 5),
    [suggestions]
  );
  const projectSuggestions = useMemo(
    () => (suggestions || [])
      .filter((s) => s.category !== "relationship")
      .slice(0, 5),
    [suggestions]
  );

  const totalActiveSuggestions = relationshipNudges.length + projectSuggestions.length;
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

  async function refresh() {
    if (!weave) return;
    try {
      const [captureState, chatSessions, appSettings, googleStatus, proactiveS] = await Promise.all([
        weave.getCaptureState(),
        weave.getChatSessions(),
        weave.getSettings(),
        weave.getGoogleAuthStatus(),
        weave.getProactiveSuggestions()
      ]);
      setCapture(captureState || emptyCapture);
      setSessions(Array.isArray(chatSessions) ? chatSessions : []);
      setSettings(appSettings);
      setGoogle(googleStatus || { connected: false });
      setSuggestions(Array.isArray(proactiveS) ? proactiveS : []);
      
      if (Array.isArray(chatSessions) && chatSessions.length > 0 && !currentSessionId && !isDraftChat) {
        setCurrentSessionId(chatSessions[0].id);
      }
    } catch (e) {
      console.error("Refresh error:", e);
    }
  }
  useEffect(() => {
    if (!weave) return;
    
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (user && user.id !== lastSwitchedUserId.current) {
        setIsSwitchingAccount(true);
        lastSwitchedUserId.current = user.id;
        try {
          await weave.switchAccount(user.id);
        } finally {
          setIsSwitchingAccount(false);
          setSupabaseUser(user);
        }
      } else {
        setSupabaseUser(user);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const user = session?.user ?? null;
      if (user && user.id !== lastSwitchedUserId.current) {
        setIsSwitchingAccount(true);
        lastSwitchedUserId.current = user.id;
        try {
          await weave.switchAccount(user.id);
        } finally {
          setIsSwitchingAccount(false);
          setSupabaseUser(user);
        }
      } else {
        setSupabaseUser(user);
      }
    });

    return () => subscription.unsubscribe();
  }, [weave]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);




  useEffect(() => {
    if (!isReady && (window as any).weave) {

      setIsReady(true);
      return;
    }
    if (!weave) {
      const timer = setInterval(() => {
        if ((window as any).weave) {
          setIsReady(true);
          clearInterval(timer);
        }
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isReady]);

  useEffect(() => {
    if (!isReady || !weave) return;
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
  }, [isReady, currentSessionId]);

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
  }, [currentSessionId, isDraftChat, isReady]);

  useEffect(() => {
    if ((view !== "explorer" && view !== "contacts") || !weave) return;
    const now = Date.now();
    if (nodes.length > 0 && (now - lastNodesFetchAtRef.current) < 45_000) return;
    lastNodesFetchAtRef.current = now;
    void weave.getMemoryNodes().then((n: any) => setNodes(Array.isArray(n) ? n : []));
  }, [view, isReady, nodes.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typedMessageContent]);

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

  async function sendMessage(overrideContent?: string) {
    const finalContent = overrideContent || input;
    if (!finalContent.trim() || isProcessing || !weave) return;
    
    let sessionId = currentSessionId;
    
    // Lazy create session if this is a "Ghost Chat" (pending state)
    if (!sessionId) {
      try {
        const session = await weave.createChatSession(`Chat ${(sessions?.length || 0) + 1}`);
        setSessions(prev => [session, ...(Array.isArray(prev) ? prev : [])]);
        setCurrentSessionId(session.id);
        currentSessionIdRef.current = session.id;
        setIsDraftChat(false);
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





  async function loginWithGoogle() {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
          redirectTo: window.location.origin,
        },
      });
      if (error) throw error;
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
    if (!confirm("Are you sure you want to delete this chat?")) return;
    const wasCurrentSession = currentSessionId === id;
    await (window as any).weave.deleteChatSession(id);
    const updated = await (window as any).weave.getChatSessions();
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

  if (!isReady || !weave || isSwitchingAccount) {
    return (
      <div className="empty-state" style={{ height: '100vh', flexDirection: 'column', gap: '20px' }}>
        <RefreshCw className="spin" />
        <div>{isSwitchingAccount ? "Switching to your local account..." : "Initializing Weave Memory Graph..."}</div>
        <div style={{ fontSize: '12px', opacity: 0.7 }}>{isSwitchingAccount ? "Preparing your private database..." : "Waiting for bridge connection..."}</div>
        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          .spin { animation: spin 2s linear infinite; }
        `}</style>
      </div>
    );
  }


  if (!supabaseUser) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-app)', padding: '40px' }}>
        <div style={{ 
          maxWidth: '440px', width: '100%', padding: '48px', 
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
            <button className="secondary-button" onClick={refresh} title="Refresh">
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
          <div style={{ padding: '60px 64px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '48px' }}>

            <div style={{ marginBottom: '48px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '28px' }}>
                  <img src={logo} alt="Weave Logo" style={{ width: '92px', height: '92px', borderRadius: '24px', boxShadow: 'var(--shadow-float)' }} />
                  <div>
                    <h1 style={{ fontSize: '36px', fontWeight: 800, letterSpacing: '-0.04em', margin: '0 0 4px 0' }}>
                      {new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'}, {(supabaseUser?.user_metadata?.full_name || supabaseUser?.user_metadata?.name || google?.email?.split('@')[0] || 'there').split(' ')[0]}.
                    </h1>


                    <p style={{ margin: 0, fontSize: '16px', color: 'var(--text-secondary)', fontWeight: 500 }}>Here's what your memory graph identified for you today.</p>
                  </div>
                </div>
                <button
                  className="secondary-button"
                  onClick={generateSuggestionsNow}
                  disabled={isGeneratingSuggestions}
                  style={{ minWidth: '180px', height: '48px', borderRadius: '14px' }}
                >
                  {isGeneratingSuggestions ? 'Syncing...' : 'Refresh Radar'}
                </button>
              </div>


            </div>


            {/* Relationship Radar Section */}
            {relationshipNudges.length > 0 && (
              <div className="home-section">
                <div className="section-header">
                  <div className="header-title">
                    <h2>Relationships</h2>
                  </div>
                </div>

                <div className="radar-grid">
                  {relationshipNudges.map(s => (
                    <div
                      key={s.id} 
                      className="radar-card"
                      onClick={() => setSelectedSuggestion(s)}
                    >
                      <div className="card-top">
                        <span className="topic-pill">{s.topic}</span>
                      </div>
                      <h3 className="card-summary">{s.summary}</h3>
                      {s.contactName && (
                        <div className="card-footer">
                          <User size={12} />
                          <span>{s.contactName}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Task list (Non-Relationship) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '700px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.4, marginBottom: '12px' }}>Tasks & Projects</div>
              {(totalActiveSuggestions === 0) ? (
                <div className="empty-state" style={{ height: '200px', flexDirection: 'column', gap: '12px' }}>
                  <Activity size={32} style={{ opacity: 0.15 }} />
                  <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Analyzing your memory…</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {projectSuggestions.map((s, idx) => {
                      const completedTasks: string[] = (s as any).completedTasks || [];
                      const allTasks = [...(s.humanTasks || []), ...(s.immediateTasks || [])];
                      const allDone = allTasks.length > 0 && allTasks.every(t => completedTasks.includes(t));
                      return (
                        <button
                          key={s.id}
                          onClick={() => setSelectedSuggestion(s)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '16px',
                            padding: '18px 20px',
                            borderRadius: '14px',
                            background: 'transparent',
                            border: 'none',
                            textAlign: 'left',
                            width: '100%',
                            cursor: 'pointer',
                            transition: 'background 0.15s ease',
                            opacity: allDone ? 0.4 : 1,
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <span style={{
                            width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                            background: allDone ? '#e8f5e9' : 'var(--accent-secondary)',
                            color: allDone ? '#4caf50' : 'var(--accent-primary)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '12px', fontWeight: 700
                          }}>
                            {allDone ? '✓' : idx + 1}
                          </span>
                          <span style={{
                            flex: 1, fontSize: '15px', fontWeight: 500,
                            textDecoration: allDone ? 'line-through' : 'none',
                            color: 'var(--text-primary)'
                          }}>
                            {s.summary || 'Untitled task'}
                          </span>
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', flexShrink: 0 }}>
                            {s.topic || 'General'}
                          </span>
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Task Detail Popup */}
        {selectedSuggestion && (
          <div
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000, backdropFilter: 'blur(4px)'
            }}
            onClick={() => setSelectedSuggestion(null)}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: '#fff', borderRadius: '24px', padding: '36px',
                maxWidth: '600px', width: '90%', maxHeight: '80vh', overflowY: 'auto',
                boxShadow: '0 24px 80px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: '24px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span className="layer-badge layer-SEMANTIC" style={{ marginBottom: '10px', display: 'inline-block' }}>
                    {selectedSuggestion.topic || 'General'}
                  </span>
                  <h2 style={{ margin: '8px 0 0 0', fontSize: '22px', fontWeight: 800, letterSpacing: '-0.02em' }}>
                    {selectedSuggestion.summary}
                  </h2>
                </div>
                <button
                  onClick={() => setSelectedSuggestion(null)}
                  style={{ background: '#f8f9fa', border: 'none', borderRadius: '50%', width: 36, height: 36, cursor: 'pointer', fontSize: '18px', color: 'var(--text-secondary)' }}
                >×</button>
              </div>

              {selectedSuggestion.plan && (
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>Plan</div>
                  <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: 'var(--text-primary)' }}>{selectedSuggestion.plan}</p>
                </div>
              )}

              {(selectedSuggestion.trigger || selectedSuggestion.whyNow || selectedSuggestion.contactName || typeof selectedSuggestion.daysSinceLastContact === "number") && (
                <div style={{ background: '#f8f9fa', borderRadius: '12px', padding: '16px', fontSize: '13px', lineHeight: 1.6 }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>Relationship Context</div>
                  {selectedSuggestion.contactName && <div><strong>Contact:</strong> {selectedSuggestion.contactName}</div>}
                  {typeof selectedSuggestion.daysSinceLastContact === "number" && <div><strong>Last touchpoint:</strong> {selectedSuggestion.daysSinceLastContact} days ago</div>}
                  {selectedSuggestion.trigger && <div><strong>Trigger:</strong> {selectedSuggestion.trigger}</div>}
                  {selectedSuggestion.whyNow && <div><strong>Why now:</strong> {selectedSuggestion.whyNow}</div>}
                </div>
              )}

              {selectedSuggestion.draftMessage && (
                <div style={{ background: 'var(--accent-secondary)', color: 'var(--accent-primary)', borderRadius: '12px', padding: '16px', fontSize: '13px', lineHeight: 1.6 }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', opacity: 0.75 }}>Suggested Opener</div>
                  <div>{selectedSuggestion.draftMessage}</div>
                </div>
              )}

              {selectedSuggestion.aiCompletedWork && (
                <div style={{ background: '#f0fdf4', borderRadius: '12px', padding: '16px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4caf50', marginBottom: '8px' }}>AI Completed</div>
                  <div style={{ fontSize: '14px', lineHeight: 1.6 }}>{selectedSuggestion.aiCompletedWork}</div>
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
                  const updated = {
                    ...(selectedSuggestion as any),
                    completedTasks: newCompleted,
                    completedAt: isFullyCompleted ? new Date().toISOString() : undefined
                  };
                  setSelectedSuggestion(updated as any);
                  setSuggestions(prev => {
                    const next = prev.map(s => s.id === selectedSuggestion.id ? updated as any : s);
                    void weave?.setProactiveSuggestions(next as any);
                    return next;
                  });
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

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: '1px solid rgba(0,0,0,0.06)' }}>
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
                            {m.retrievalTrace.memoryNodes && m.retrievalTrace.memoryNodes.length > 0 && (
                              <div className="trace-nodes">
                                {m.retrievalTrace.memoryNodes.map((title: string, i: number) => (
                                  <span key={i} className="node-pill">{title}</span>
                                ))}
                              </div>
                            )}
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
                        <button className="secondary-button" onClick={() => (window as any).weave.syncGoogle()} style={{ height: '32px', fontSize: '12px' }}>
                          Sync Now
                        </button>
                        <button className="secondary-button" onClick={() => weave.startAuth()} style={{ height: '32px', fontSize: '12px' }}>Reconnect</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                      <button 
                        className="primary-button" 
                        onClick={() => weave.startAuth()} 
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
                          await (window as any).weave.syncAppleContacts();
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
                  onBlur={(e) => (window as any).weave.updateSettings({ blacklistedApps: e.target.value.split('\n') })}
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
                  onBlur={(e) => (window as any).weave.updateSettings({ blacklistedWebsites: e.target.value.split('\n') })}
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

            <div className="settings-section" style={{ border: '1px solid #fee2e2' }}>
              <h3 style={{ color: '#dc2626' }}>Danger Zone</h3>
              <div className="settings-row">
                <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                  This will permanently delete all memory nodes, relationship data, and chat history.
                </p>
                <button 
                  className="secondary-button" 
                  style={{ color: '#dc2626', borderColor: '#fee2e2', background: '#fff' }}
                  onClick={() => {
                    if (confirm("Are you sure you want to delete ALL data? This action is permanent.")) {
                      (window as any).weave.deleteAllData().then(() => {
                        window.location.reload();
                      });
                    }
                  }}
                >
                  Delete All Local Data
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
