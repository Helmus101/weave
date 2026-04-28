import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Layer 1: Raw Events
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // ocr, gmail, calendar, etc.
  timestamp: text("timestamp").notNull(),
  source: text("source").notNull(),
  text: text("text"),
  metadata: text("metadata").notNull().default("{}"),
  ocrHash: text("ocr_hash"),
  sentimentScore: real("sentiment_score"),
  sessionId: text("session_id"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull()
});

// Layers 2-6: Memory Graph Nodes
export const memoryNodes = sqliteTable("memory_nodes", {
  id: text("id").primaryKey(),
  layer: text("layer").notNull(), // RAW, EPISODE, SEMANTIC, CLOUD, INSIGHT, CORE
  subtype: text("subtype"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  canonicalText: text("canonical_text").notNull(),
  confidence: real("confidence").notNull().default(1.0),
  status: text("status").notNull().default("active"),
  sourceRefs: text("source_refs"), // JSON array of event or node IDs
  metadata: text("metadata").notNull().default("{}"),
  graphVersion: text("graph_version"),
  importance: integer("importance").notNull().default(5),
  connectionCount: integer("connection_count").notNull().default(0),
  lastReheated: text("last_reheated"),
  anchorAt: text("anchor_at"),
  anchorDate: text("anchor_date"),
  embedding: text("embedding"), // Store as JSON string or float array if needed
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const memoryEdges = sqliteTable("memory_edges", {
  id: text("id").primaryKey(),
  fromId: text("from_id").notNull(),
  toId: text("to_id").notNull(),
  relation: text("relation").notNull(), // MENTIONS, FOLLOWS_UP, PART_OF_EPISODE, etc.
  weight: real("weight").notNull().default(1.0),
  traceLabel: text("trace_label"),
  evidenceCount: integer("evidence_count").notNull().default(1),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull()
});

// Vector Retrieval Support (FTS and metadata)
export const textChunks = sqliteTable("text_chunks", {
  id: text("id").primaryKey(),
  nodeId: text("node_id"),
  eventId: text("event_id"),
  chunkIndex: integer("chunk_index").notNull(),
  text: text("text").notNull(),
  embedding: text("embedding"),
  timestamp: text("timestamp"),
  date: text("date"),
  app: text("app"),
  dataSource: text("data_source"),
  metadata: text("metadata").notNull().default("{}")
});

// Persistent Chat Sessions
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text("role").notNull(), // user, assistant
  content: text("content").notNull(),
  thinkingTrace: text("thinking_trace"),
  timestamp: integer("ts").notNull(),
  createdAt: text("created_at").notNull()
});

// Utilities
export const appBlacklist = sqliteTable("app_blacklist", {
  id: text("id").primaryKey(),
  matcher: text("matcher").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => ({
  matcherIdx: uniqueIndex("app_blacklist_matcher_idx").on(table.matcher)
}));

export const integrationAccounts = sqliteTable("integration_accounts", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // google, etc.
  email: text("email"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiryDate: integer("expiry_date"),
  scopes: text("scopes").notNull().default("[]"),
  lastSyncAt: text("last_sync_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const kvCache = sqliteTable("kv_cache", {
  key: text("key").primaryKey(),
  value: text("value"),
  type: text("type"),
  createdAt: text("created_at").notNull()
});
