const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { z } = require("zod");
const { createClient } = require("@supabase/supabase-js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const { loadDotEnv } = require("../dist/main/main/config/env.js");
const { WeaveDatabase } = require("../dist/main/main/db/client.js");
const { VectorStore } = require("../dist/main/main/services/vectorStore.js");
const { DeepSeekService } = require("../dist/main/main/services/deepseek.js");
const { RetrievalService } = require("../dist/main/main/services/retrieval.js");
const { IntelligenceEngine } = require("../dist/main/main/services/intelligence.js");
const { ProactiveService } = require("../dist/main/main/services/proactive.js");
const { RoutineService } = require("../dist/main/main/services/routines.js");
const { SettingsService } = require("../dist/main/main/services/settings.js");

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function toTextResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function parseLayers(input) {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  return input.filter((value) => ["RAW", "EPISODE", "SEMANTIC", "CLOUD", "INSIGHT", "CORE"].includes(value));
}

function resolveUserDataPath() {
  const explicit = (process.env.WEAVE_USER_DATA_DIR || "").trim();
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true });
    return explicit;
  }

  const candidate = path.join(os.homedir(), "Library", "Application Support", "Weave");
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

function resolveDbPath(userDataPath, accountId) {
  const dataDir = path.join(userDataPath, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, accountId === "default" ? "weave.sqlite" : `weave_${accountId}.sqlite`);
}

function resolveVectorPath(userDataPath, accountId) {
  const vectorPath = path.join(userDataPath, "data", "vectors", accountId);
  fs.mkdirSync(vectorPath, { recursive: true });
  return vectorPath;
}

async function createRuntime(accountOverride) {
  loadDotEnv(process.cwd());

  const userDataPath = resolveUserDataPath();
  const settings = new SettingsService(userDataPath);
  const accountId = accountOverride || settings.activeAccountId || "default";
  const dbPath = resolveDbPath(userDataPath, accountId);
  const vectorPath = resolveVectorPath(userDataPath, accountId);

  const db = await WeaveDatabase.open(dbPath);
  const vectors = new VectorStore(vectorPath);
  await vectors.init();
  const deepseek = new DeepSeekService(() => settings.deepseekApiKey());
  const retrieval = new RetrievalService(db, vectors, deepseek);
  const intelligence = new IntelligenceEngine(db, retrieval, deepseek, vectors);
  const proactive = new ProactiveService(db, retrieval, intelligence);
  const routines = new RoutineService(db, retrieval, intelligence);

  return {
    userDataPath,
    accountId,
    db,
    vectors,
    settings,
    retrieval,
    intelligence,
    proactive,
    routines,
    async close() {
      db.close();
    }
  };
}

function createSupabaseVerifier() {
  const url = (process.env.VITE_SUPABASE_URL || "").trim();
  const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) {
    throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required for remote HTTP mode.");
  }
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function buildServer(runtime) {
  const server = new McpServer({ name: "weave-mcp", version: "0.1.0" });

  server.registerTool("weave_status", {
    title: "Weave Status",
    description: "Get the current Weave account, settings summary, and subsystem health."
  }, async () => {
    const google = runtime.db.googleAccount();
    const result = {
      accountId: runtime.accountId,
      userDataPath: runtime.userDataPath,
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
  }, async ({ query, limit, apps, dateStart, dateEnd, layers }) => {
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
  }, async ({ prompt, sessionId, title }) => {
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

  server.registerTool("list_chat_sessions", {
    title: "List Weave Chat Sessions",
    description: "List saved Weave chat sessions."
  }, async () => {
    const sessions = runtime.db.getChatSessions();
    return toTextResult(safeJson({ sessions }), { sessions });
  });

  server.registerTool("get_chat_messages", {
    title: "Get Weave Chat Messages",
    description: "Fetch saved messages for a Weave chat session.",
    inputSchema: {
      sessionId: z.string().min(1)
    }
  }, async ({ sessionId }) => {
    const messages = runtime.db.getChatMessages(sessionId);
    return toTextResult(safeJson({ sessionId, messages }), { sessionId, messages });
  });

  server.registerTool("get_capture_health", {
    title: "Get Capture Health",
    description: "Read Weave capture/system health, including queue depth and cadence."
  }, async () => {
    const payload = {
      captureEnabled: runtime.settings.captureEnabled,
      subsystemHealth: runtime.db.getSubsystemHealth().capture || {}
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

  server.registerTool("generate_proactive_suggestions", {
    title: "Generate Proactive Suggestions",
    description: "Force a new proactive-priority generation pass."
  }, async () => {
    const suggestions = await runtime.proactive.generateSuggestions();
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
  }, async ({ routineId }) => {
    const run = await runtime.routines.runRoutineNow(routineId);
    return toTextResult(safeJson(run), run);
  });

  server.registerTool("get_memory_node", {
    title: "Get Memory Node",
    description: "Fetch a memory node and its graph edges by ID.",
    inputSchema: {
      nodeId: z.string().min(1)
    }
  }, async ({ nodeId }) => {
    const node = runtime.db.getMemoryNode(nodeId);
    const edges = runtime.db.getMemoryEdges(nodeId);
    const payload = { node, edges };
    return toTextResult(safeJson(payload), payload);
  });

  server.registerTool("list_memory_nodes", {
    title: "List Memory Nodes",
    description: "List recent memory nodes, optionally filtered by layer.",
    inputSchema: {
      layer: z.enum(["RAW", "EPISODE", "SEMANTIC", "CLOUD", "INSIGHT", "CORE"]).optional(),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, async ({ layer, limit }) => {
    const nodes = (layer ? runtime.db.getMemoryNodes(layer) : runtime.db.getMemoryNodes()).slice(0, limit || 30);
    return toTextResult(safeJson({ nodes }), { nodes });
  });

  server.registerResource("weave-status", "weave://status", {
    title: "Weave Status",
    description: "Current Weave account and subsystem health.",
    mimeType: "application/json"
  }, async () => ({
    contents: [{
      uri: "weave://status",
      text: safeJson({
        accountId: runtime.accountId,
        settings: runtime.settings.snapshot(),
        subsystemHealth: runtime.db.getSubsystemHealth()
      }),
      mimeType: "application/json"
    }]
  }));

  server.registerResource("weave-routines", "weave://routines", {
    title: "Weave Routines",
    description: "Current routine definitions.",
    mimeType: "application/json"
  }, async () => ({
    contents: [{
      uri: "weave://routines",
      text: safeJson(runtime.routines.getRoutines()),
      mimeType: "application/json"
    }]
  }));

  return server;
}

async function startStdio(accountId) {
  const runtime = await createRuntime(accountId);
  const server = buildServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    await runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function startHttp(accountId) {
  const runtime = await createRuntime(accountId);
  if (!runtime.settings.rawCloudAllowed) {
    throw new Error("Remote MCP is disabled in Weave settings. Enable cloud access in Settings before starting HTTP mode.");
  }
  if (runtime.accountId === "default") {
    throw new Error("Remote MCP requires a signed-in account namespace, not the default local account.");
  }
  const supabase = createSupabaseVerifier();
  const server = buildServer(runtime);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await server.connect(transport);

  const port = Number(process.env.WEAVE_MCP_PORT || 8787);
  const host = (process.env.WEAVE_MCP_HOST || "0.0.0.0").trim() || "0.0.0.0";
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing URL");
      return;
    }

    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "weave-mcp", port }));
      return;
    }

    if (req.url !== "/mcp") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const authHeader = String(req.headers.authorization || "");
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Missing Supabase bearer token" }));
      return;
    }

    const token = tokenMatch[1];
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Invalid Supabase session token" }));
      return;
    }
    if (data.user.id !== runtime.accountId) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Supabase user does not match this Weave account" }));
      return;
    }

    await transport.handleRequest(req, res);
  });

  httpServer.listen(port, host, () => {
    console.error(`[weave-mcp] listening on http://${host}:${port}/mcp`);
  });

  const shutdown = async () => {
    httpServer.close();
    await server.close();
    await runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function main() {
  const mode = process.argv.includes("--http") ? "http" : "stdio";
  const accountIndex = process.argv.findIndex((value) => value === "--account");
  const accountId = accountIndex >= 0 ? process.argv[accountIndex + 1] : undefined;

  if (mode === "http") {
    await startHttp(accountId);
    return;
  }

  await startStdio(accountId);
}

main().catch((error) => {
  console.error("[weave-mcp] failed to start:", error);
  process.exit(1);
});
