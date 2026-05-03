import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { MemoryLayer } from "../../shared/types";
import type { WeaveDatabase } from "../db/client";
import type { RetrievalService } from "./retrieval";
import type { IntelligenceEngine } from "./intelligence";
import type { ProactiveService } from "./proactive";
import type { RoutineService } from "./routines";
import type { SettingsService } from "./settings";

interface RemoteMcpRuntime {
  accountId: string;
  db: WeaveDatabase;
  retrieval: RetrievalService;
  intelligence: IntelligenceEngine;
  proactive: ProactiveService;
  routines: RoutineService;
  settings: SettingsService;
}

function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function toTextResult(text: string, structuredContent?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function parseLayers(input: string[] | undefined): MemoryLayer[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  return input.filter((value): value is MemoryLayer => ["RAW", "EPISODE", "SEMANTIC", "CLOUD", "INSIGHT", "CORE"].includes(value));
}

function createSupabaseVerifier() {
  const url = (process.env.VITE_SUPABASE_URL || "").trim();
  const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) {
    throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required for remote MCP mode.");
  }
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function buildServer(runtime: RemoteMcpRuntime) {
  const server: any = new McpServer({ name: "weave-mcp", version: "0.1.0" });

  server.registerTool("weave_status", {
    title: "Weave Status",
    description: "Get the current Weave account, settings summary, and subsystem health."
  }, async () => {
    const google = runtime.db.googleAccount();
    const result = {
      accountId: runtime.accountId,
      settings: runtime.settings.snapshot(),
      googleConnected: Boolean(google && google.email),
      googleEmail: google && google.email,
      subsystemHealth: runtime.db.getSubsystemHealth()
    };
    return toTextResult(safeJson(result), result);
  });

  server.registerTool("search_memory", {
    title: "Search Weave Memory",
    description: "Search Weave memory across RAW, EPISODE, INSIGHT, and SEMANTIC layers.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      apps: z.array(z.string()).optional(),
      dateStart: z.string().optional(),
      dateEnd: z.string().optional(),
      layers: z.array(z.string()).optional()
    }
  }, async ({ query, limit, apps, dateStart, dateEnd, layers }: any) => {
    const { results, trace, filters } = await runtime.retrieval.searchWithTrace(query, limit || 8, {
      apps,
      dateStart,
      dateEnd,
      layers: parseLayers(layers)
    });
    const payload = { query, filters, trace, results };
    return toTextResult(safeJson(payload), payload);
  });

  server.registerTool("ask_weave", {
    title: "Ask Weave",
    description: "Run Weave's memory-grounded chat pipeline and return the answer plus the backing retrieval trace.",
    inputSchema: {
      prompt: z.string().min(1),
      sessionId: z.string().optional(),
      title: z.string().optional()
    }
  }, async ({ prompt, sessionId, title }: any) => {
    const session = sessionId
      ? runtime.db.getChatSession(sessionId) || runtime.db.createChatSession(title || "MCP Chat")
      : runtime.db.createChatSession(title || "MCP Chat");
    await runtime.intelligence.processChat(session.id, prompt);
    const messages = runtime.db.getChatMessages(session.id);
    const answer = [...messages].reverse().find((message) => message.role === "assistant");
    const payload = {
      sessionId: session.id,
      answer: answer ? answer.content : "",
      retrievalTrace: answer ? answer.retrievalTrace : null
    };
    return toTextResult(safeJson(payload), payload);
  });

  server.registerTool("get_proactive_suggestions", {
    title: "Get Proactive Suggestions",
    description: "Return Weave's current executive-priority suggestions."
  }, async () => {
    const suggestions = runtime.proactive.getSuggestions();
    return toTextResult(safeJson({ suggestions }), { suggestions });
  });

  server.registerTool("get_routines", {
    title: "Get Routines",
    description: "List Weave routines and their schedules."
  }, async () => {
    const routines = runtime.routines.getRoutines();
    return toTextResult(safeJson({ routines }), { routines });
  });

  server.registerTool("run_routine", {
    title: "Run Routine",
    description: "Run a Weave routine immediately and return the generated briefing.",
    inputSchema: {
      routineId: z.string().min(1)
    }
  }, async ({ routineId }: any) => {
    const run = await runtime.routines.runRoutineNow(routineId);
    return toTextResult(safeJson(run), run);
  });

  return server;
}

export class RemoteMcpService {
  private httpServer: http.Server | null = null;
  private transport: any = null;
  private mcpServer: any = null;
  private runtime: RemoteMcpRuntime | null = null;
  private readonly host = (process.env.WEAVE_MCP_HOST || "0.0.0.0").trim() || "0.0.0.0";
  private readonly port = Number(process.env.WEAVE_MCP_PORT || 8787);

  updateRuntime(runtime: RemoteMcpRuntime) {
    this.runtime = runtime;
  }

  getEndpoint() {
    return `http://${this.host}:${this.port}/mcp`;
  }

  async start(runtime: RemoteMcpRuntime) {
    this.runtime = runtime;
    if (this.httpServer) return;
    if (!runtime.settings.rawCloudAllowed || runtime.accountId === "default") return;

    const supabase = createSupabaseVerifier();
    this.mcpServer = buildServer(runtime);
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await this.mcpServer.connect(this.transport);

    this.httpServer = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res, supabase);
      } catch (error) {
        console.error("[Remote MCP] Request failed:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "Internal MCP error" }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once("error", reject);
      this.httpServer?.listen(this.port, this.host, () => resolve());
    });
    console.log(`[Remote MCP] Listening on ${this.getEndpoint()}`);
  }

  async stop() {
    const server = this.httpServer;
    this.httpServer = null;
    this.transport = null;
    this.mcpServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    supabase: ReturnType<typeof createSupabaseVerifier>
  ) {
    const runtime = this.runtime;
    if (!runtime || !runtime.settings.rawCloudAllowed || runtime.accountId === "default") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Remote MCP unavailable" }));
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        accountId: runtime.accountId,
        endpoint: this.getEndpoint()
      }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    if (!token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing bearer token" }));
      return;
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid Supabase session" }));
      return;
    }

    if (data.user.id !== runtime.accountId) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Supabase user does not match active Weave account" }));
      return;
    }

    if (!this.transport) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "MCP transport unavailable" }));
      return;
    }

    await this.transport.handleRequest(req, res);
  }
}
