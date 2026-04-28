import type initSqlJs from "sql.js";

const baseStatements = [
  `DROP TABLE IF EXISTS people`,
  `DROP TABLE IF EXISTS organizations`,
  `DROP TABLE IF EXISTS projects`,
  `DROP TABLE IF EXISTS interactions`,
  `DROP TABLE IF EXISTS interactions_fts`,
  `DROP TABLE IF EXISTS edges`,
  `DROP TABLE IF EXISTS follow_ups`,
  `DROP TABLE IF EXISTS daily_stitches`,
  `DROP TABLE IF EXISTS events`,

  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    ocr_hash TEXT,
    sentiment_score REAL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memory_nodes (
    id TEXT PRIMARY KEY,
    layer TEXT NOT NULL,
    subtype TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    canonical_text TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'active',
    importance INTEGER NOT NULL DEFAULT 5,
    connection_count INTEGER NOT NULL DEFAULT 0,
    last_reheated TEXT,
    anchor_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    embedding TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS core_identity (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memory_edges (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS text_chunks (
    id TEXT PRIMARY KEY,
    node_id TEXT,
    event_id TEXT,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT,
    timestamp TEXT,
    date TEXT,
    app TEXT,
    data_source TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    thinking_trace TEXT,
    retrieval_trace TEXT,
    ts INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS app_blacklist (
    id TEXT PRIMARY KEY,
    matcher TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS integration_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expiry_date INTEGER,
    scopes TEXT NOT NULL DEFAULT '[]',
    last_sync_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS kv_cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    type TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_nodes_layer ON memory_nodes(layer)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`
] as const;

const ftsStatements = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(node_id, title, summary, canonical_text)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS text_chunks_fts USING fts5(chunk_id, text)`,
  `INSERT INTO memory_nodes_fts(node_id, title, summary, canonical_text)
   SELECT id, title, summary, canonical_text FROM memory_nodes`,
  `CREATE TRIGGER IF NOT EXISTS memory_nodes_ai AFTER INSERT ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(node_id, title, summary, canonical_text) VALUES (new.id, new.title, new.summary, new.canonical_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memory_nodes_ad AFTER DELETE ON memory_nodes BEGIN
    DELETE FROM memory_nodes_fts WHERE node_id = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS memory_nodes_au AFTER UPDATE ON memory_nodes BEGIN
    DELETE FROM memory_nodes_fts WHERE node_id = old.id;
    INSERT INTO memory_nodes_fts(node_id, title, summary, canonical_text) VALUES (new.id, new.title, new.summary, new.canonical_text);
  END`
] as const;

const cleanupFtsStatements = [
  `DROP TRIGGER IF EXISTS memory_nodes_ai`,
  `DROP TRIGGER IF EXISTS memory_nodes_ad`,
  `DROP TRIGGER IF EXISTS memory_nodes_au`,
  `DROP TABLE IF EXISTS memory_nodes_fts`,
  `DROP TABLE IF EXISTS text_chunks_fts`
] as const;

export function runMigrations(sqlite: initSqlJs.Database) {
  console.log("[Database] Running migrations...");

  for (const statement of baseStatements) {
    runSafely(sqlite, statement);
  }

  ensureChatRetrievalTraceColumn(sqlite);

  const supportsFts5 = hasFts5(sqlite);
  for (const statement of cleanupFtsStatements) {
    runSafely(sqlite, statement);
  }

  if (supportsFts5) {
    for (const statement of ftsStatements) {
      runSafely(sqlite, statement);
    }
    console.log("[Database] FTS5 search index enabled.");
  } else {
    console.info("[Database] FTS5 unavailable in this runtime. Search will use standard LIKE queries (slower).");
  }

}

function ensureChatRetrievalTraceColumn(sqlite: initSqlJs.Database) {
  try {
    const result = sqlite.exec("PRAGMA table_info(chat_messages)");
    const columns = result[0]?.values?.map((row) => String(row[1])) ?? [];
    if (!columns.includes("retrieval_trace")) {
      sqlite.run("ALTER TABLE chat_messages ADD COLUMN retrieval_trace TEXT");
    }
  } catch (error) {
    console.warn("[Database] Failed to verify chat_messages schema.", error);
  }
}

function hasFts5(sqlite: initSqlJs.Database) {
  try {
    sqlite.run("CREATE VIRTUAL TABLE temp.__weave_fts5_test USING fts5(content)");
    sqlite.run("DROP TABLE temp.__weave_fts5_test");
    return true;
  } catch {
    return false;
  }
}

function runSafely(sqlite: initSqlJs.Database, statement: string) {
  try {
    sqlite.run(statement);
  } catch (error) {
    const message = String(error);
    if (!message.includes("already exists") && !message.includes("duplicate column")) {
      console.warn(`[Database] Migration failed for statement: "${statement.slice(0, 60)}..."`, error);
    }
  }
}
