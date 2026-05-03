import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { runMigrations } from "./migrations";
import type { MemoryNode, MemoryEdge, ChatSession, ChatMessage, MemoryLayer } from "../../shared/types";
import { createId } from "../utils/id";

export interface EventInput {
  type: string;
  timestamp: string;
  source: string;
  text?: string;
  metadata?: Record<string, any>;
  ocrHash?: string;
}

export interface MemoryNodeInput {
  layer: MemoryLayer;
  subtype?: string;
  title: string;
  summary: string;
  canonicalText: string;
  confidence?: number;
  sourceRefs?: string[];
  metadata?: Record<string, any>;
  importance?: number;
  anchorAt?: string;
}

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

export class WeaveDatabase {
  private ftsDisabled = false;
  private ftsFallbackLogged = false;
  private batchDepth = 0;
  private dirty = false;
  private kvMemory = new Map<string, any>();
  private kvLoaded = new Set<string>();

  private constructor(private sqlite: initSqlJs.Database, private dbPath: string) {}

  static async open(dbPath: string): Promise<WeaveDatabase> {
    const SQL = await initSqlJs();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
    runMigrations(sqlite);
    const db = new WeaveDatabase(sqlite, dbPath);
    db.initializeFtsState();
    db.seedDefaults();
    db.persist();
    return db;
  }

  private initializeFtsState() {
    try {
      const result = this.sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_nodes_fts'");
      const hasFtsTable = Array.isArray(result) && result.length > 0;
      this.ftsDisabled = !hasFtsTable;
      if (!hasFtsTable) {
        this.ftsFallbackLogged = true;
      }
    } catch {
      this.ftsDisabled = true;
      this.ftsFallbackLogged = true;
    }
  }

  close() {
    this.persist();
    this.sqlite.close();
  }

  // --- Layer 1: Events ---

  addEvent(input: EventInput): string {
    const id = createId();
    const createdAt = new Date().toISOString();
    this.run(
      `INSERT INTO events (id, type, timestamp, source, text, metadata, ocr_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.type,
        input.timestamp,
        input.source,
        input.text ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ocrHash ?? null,
        createdAt
      ]
    );
    this.persistIfNeeded();
    return id;
  }

  getRecentEvents(limit = 10): any[] {
    return this.all(`SELECT * FROM events ORDER BY timestamp DESC LIMIT ?`, [limit]).map(row => ({
      id: stringValue(row.id),
      type: stringValue(row.type),
      timestamp: stringValue(row.timestamp),
      source: stringValue(row.source),
      text: optionalString(row.text),
      metadata: safeJson(stringValue(row.metadata), {}),
      ocrHash: optionalString(row.ocr_hash),
      createdAt: stringValue(row.created_at)
    }));
  }

  getEvent(id: string) {
    const row = this.one(`SELECT * FROM events WHERE id = ?`, [id]);
    if (!row) return undefined;
    return {
      id: stringValue(row.id),
      type: stringValue(row.type),
      timestamp: stringValue(row.timestamp),
      source: stringValue(row.source),
      text: optionalString(row.text),
      metadata: safeJson(stringValue(row.metadata), {}),
      ocrHash: optionalString(row.ocr_hash),
      createdAt: stringValue(row.created_at)
    };
  }

  getEventsByIds(ids: string[]) {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    return uniqueIds.map((id) => this.getEvent(id)).filter(Boolean);
  }

  getRecentEventsBySource(source: string, limit = 100): any[] {
    return this.all(
      `SELECT * FROM events WHERE source = ? ORDER BY timestamp DESC LIMIT ?`,
      [source, limit]
    ).map(row => ({
      id: stringValue(row.id),
      type: stringValue(row.type),
      timestamp: stringValue(row.timestamp),
      source: stringValue(row.source),
      text: optionalString(row.text),
      metadata: safeJson(stringValue(row.metadata), {}),
      ocrHash: optionalString(row.ocr_hash),
      createdAt: stringValue(row.created_at)
    }));
  }

  searchEventsByKeywords(keywords: string[], limit = 100): any[] {
    const normalized = Array.from(new Set(
      keywords
        .map((keyword) => String(keyword || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    if (normalized.length === 0) return [];

    const clauses = normalized.map(() => "LOWER(COALESCE(text, '')) LIKE ?");
    const params: SqlValue[] = normalized.map((keyword) => `%${keyword}%`);
    params.push(limit);

    return this.all(
      `SELECT * FROM events WHERE ${clauses.join(" OR ")} ORDER BY timestamp DESC LIMIT ?`,
      params
    ).map(row => ({
      id: stringValue(row.id),
      type: stringValue(row.type),
      timestamp: stringValue(row.timestamp),
      source: stringValue(row.source),
      text: optionalString(row.text),
      metadata: safeJson(stringValue(row.metadata), {}),
      ocrHash: optionalString(row.ocr_hash),
      createdAt: stringValue(row.created_at)
    }));
  }

  // --- Layer: Core Identity (The User Handbook) ---

  setCoreIdentity(key: string, value: any) {
    const now = new Date().toISOString();
    this.run(
      `INSERT OR REPLACE INTO core_identity (key, value, updated_at) VALUES (?, ?, ?)`,
      [key, JSON.stringify(value), now]
    );
    this.persistIfNeeded();
  }

  getCoreIdentity(): Record<string, any> {
    const rows = this.all(`SELECT * FROM core_identity`);
    const identity: Record<string, any> = {};
    for (const row of rows) {
      identity[stringValue(row.key)] = safeJson(stringValue(row.value), {});
    }
    return identity;
  }

  // --- Layers 2-6: Memory Graph ---

  addMemoryNode(input: MemoryNodeInput): string {
    const id = createId();
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO memory_nodes (
        id, layer, subtype, title, summary, canonical_text, confidence, 
        status, source_refs, importance, last_reheated, anchor_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.layer,
        input.subtype ?? null,
        input.title,
        input.summary,
        input.canonicalText,
        input.confidence ?? 1.0,
        "active",
        JSON.stringify(input.sourceRefs ?? []),
        input.importance ?? 5,
        now,
        input.anchorAt ?? now,
        JSON.stringify(input.metadata ?? {}),
        now,
        now
      ]
    );
    this.persistIfNeeded();
    return id;
  }

  addMemoryEdge(fromId: string, toId: string, relation: string, weight = 1.0, metadata = {}): string {
    const id = createId();
    this.run(
      `INSERT INTO memory_edges (id, from_id, to_id, relation, weight, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, fromId, toId, relation, weight, JSON.stringify(metadata), new Date().toISOString()]
    );
    this.run(
      `UPDATE memory_nodes SET connection_count = connection_count + 1, updated_at = ? WHERE id = ? OR id = ?`,
      [new Date().toISOString(), fromId, toId]
    );
    this.persistIfNeeded();
    return id;
  }

  getMemoryNodes(layer?: MemoryLayer): MemoryNode[] {
    const sql = layer 
      ? `SELECT * FROM memory_nodes WHERE layer = ? ORDER BY created_at DESC`
      : `SELECT * FROM memory_nodes ORDER BY created_at DESC`;
    return this.all(sql, layer ? [layer] : []).map(row => this.mapMemoryNode(row));
  }

  searchMemoryNodesBM25(query: string, limit = 10, filters?: { apps?: string[], dateStart?: string, dateEnd?: string, layers?: MemoryLayer[] }): MemoryNode[] {
    if (this.ftsDisabled) {
      return this.searchMemoryNodesLike(query, limit, filters);
    }

    try {
      const matchQuery = this.buildSafeFtsMatchQuery(query);
      if (!matchQuery) return [];

      // FTS5 search using BM25 ranking with metadata pre-filtering (Hard Gate)
      let sql = `
        SELECT m.*, bm25(memory_nodes_fts) as rank
        FROM memory_nodes_fts
        JOIN memory_nodes m ON memory_nodes_fts.node_id = m.id
        WHERE memory_nodes_fts MATCH ?
      `;
      const params: SqlValue[] = [];

      params.push(matchQuery);

      if (filters?.layers && filters.layers.length > 0) {
        sql += ` AND m.layer IN (${filters.layers.map(() => "?").join(",")})`;
        params.push(...filters.layers);
      }

      if (filters?.apps && filters.apps.length > 0) {
        sql += ` AND json_extract(m.metadata, '$.app') IN (${filters.apps.map(() => "?").join(",")})`;
        params.push(...filters.apps);
      }

      if (filters?.dateStart) {
        sql += ` AND m.anchor_at >= ?`;
        params.push(filters.dateStart);
      }

      if (filters?.dateEnd) {
        sql += ` AND m.anchor_at <= ?`;
        params.push(filters.dateEnd);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      return this.all(sql, params).map(row => this.mapMemoryNode(row));
    } catch (e) {
      this.ftsDisabled = true;
      if (!this.ftsFallbackLogged) {
        console.warn(`[Database] FTS search failed, disabling FTS for this session and falling back to LIKE search. Reason: ${e instanceof Error ? e.message : String(e)}`);
        this.ftsFallbackLogged = true;
      }
      return this.searchMemoryNodesLike(query, limit, filters);
    }
  }

  private buildSafeFtsMatchQuery(query: string): string {
    const tokens = String(query || "")
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) ?? [];

    if (tokens.length === 0) return "";

    // Keep FTS queries short and explicit to avoid parser/syntax edge cases.
    const uniqueTokens = Array.from(new Set(tokens)).slice(0, 12);
    return uniqueTokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" ");
  }

  private searchMemoryNodesLike(query: string, limit = 10, filters?: { apps?: string[], dateStart?: string, dateEnd?: string, layers?: MemoryLayer[] }): MemoryNode[] {
    const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (tokens.length === 0) return [];

    let sql = `SELECT * FROM memory_nodes m WHERE 1=1`;
    const params: SqlValue[] = [];

    if (filters?.layers && filters.layers.length > 0) {
      sql += ` AND m.layer IN (${filters.layers.map(() => "?").join(",")})`;
      params.push(...filters.layers);
    }

    if (filters?.apps && filters.apps.length > 0) {
      sql += ` AND json_extract(m.metadata, '$.app') IN (${filters.apps.map(() => "?").join(",")})`;
      params.push(...filters.apps);
    }

    if (filters?.dateStart) {
      sql += ` AND m.anchor_at >= ?`;
      params.push(filters.dateStart);
    }

    if (filters?.dateEnd) {
      sql += ` AND m.anchor_at <= ?`;
      params.push(filters.dateEnd);
    }

    const likeClauses = tokens.map(() => `(LOWER(m.title) LIKE ? OR LOWER(m.summary) LIKE ? OR LOWER(m.canonical_text) LIKE ?)`);
    sql += ` AND (${likeClauses.join(" OR ")})`;
    for (const token of tokens) {
      const pattern = `%${token}%`;
      params.push(pattern, pattern, pattern);
    }

    sql += ` ORDER BY m.anchor_at DESC LIMIT ?`;
    params.push(limit * 4);

    const rows = this.all(sql, params).map((row) => this.mapMemoryNode(row));
    return rows
      .map((node) => ({
        node,
        score: tokens.reduce((sum, token) => {
          const haystack = `${node.title}\n${node.summary}\n${node.canonicalText}`.toLowerCase();
          return sum + (haystack.includes(token) ? 1 : 0);
        }, 0)
      }))
      .sort((a, b) => b.score - a.score || new Date(b.node.anchorAt || b.node.createdAt).getTime() - new Date(a.node.anchorAt || a.node.createdAt).getTime())
      .slice(0, limit)
      .map(({ node }) => node);
  }

  updateMemoryNodeMetadata(id: string, metadata: any) {
    const now = new Date().toISOString();
    this.run(`UPDATE memory_nodes SET metadata = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(metadata), now, id]);
    this.persistIfNeeded();
  }

  updateMemoryNode(id: string, updates: { metadata?: any, canonicalText?: string, title?: string, summary?: string }) {
    const now = new Date().toISOString();
    const fields: string[] = [];
    const params: any[] = [];

    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.canonicalText !== undefined) {
      fields.push("canonical_text = ?");
      params.push(updates.canonicalText);
    }
    if (updates.title !== undefined) {
      fields.push("title = ?");
      params.push(updates.title);
    }
    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      params.push(updates.summary);
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      params.push(now);
      params.push(id);
      this.run(`UPDATE memory_nodes SET ${fields.join(", ")} WHERE id = ?`, params);
      this.persistIfNeeded();
    }
  }


  getMemoryNodesByFilters(filters: { app?: string, dateStart?: string, dateEnd?: string, layers?: MemoryLayer[], subtype?: string, windowTitle?: string }, limit = 50): MemoryNode[] {
    let sql = `SELECT * FROM memory_nodes WHERE 1=1`;
    const params: SqlValue[] = [];
    
    if (filters.app) {
      sql += ` AND json_extract(metadata, '$.app') = ?`;
      params.push(filters.app);
    }

    if (filters.windowTitle) {
      sql += ` AND json_extract(metadata, '$.windowTitle') = ?`;
      params.push(filters.windowTitle);
    }

    if (filters.subtype) {
      sql += ` AND subtype = ?`;
      params.push(filters.subtype);
    }

    if (filters.layers?.length) {
      sql += ` AND layer IN (${filters.layers.map(() => "?").join(", ")})`;
      params.push(...filters.layers);
    }
    
    if (filters.dateStart) {
      sql += ` AND anchor_at >= ?`;
      params.push(filters.dateStart);
    }
    
    if (filters.dateEnd) {
      sql += ` AND anchor_at <= ?`;
      params.push(filters.dateEnd);
    }
    
    sql += ` ORDER BY anchor_at DESC LIMIT ?`;
    params.push(limit);
    
    return this.all(sql, params).map(row => this.mapMemoryNode(row));
  }

  getMemoryNode(id: string): MemoryNode | undefined {
    const row = this.one(`SELECT * FROM memory_nodes WHERE id = ?`, [id]);
    return row ? this.mapMemoryNode(row) : undefined;
  }

  getMemoryNodesByLayerAndSubtype(layer: MemoryLayer, subtype: string, limit = 500): MemoryNode[] {
    return this.all(
      `SELECT * FROM memory_nodes WHERE layer = ? AND subtype = ? ORDER BY anchor_at DESC, created_at DESC LIMIT ?`,
      [layer, subtype, limit]
    ).map((row) => this.mapMemoryNode(row));
  }

  getMemoryNodesByIds(ids: string[]): MemoryNode[] {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    return uniqueIds.map((id) => this.getMemoryNode(id)).filter((node): node is MemoryNode => Boolean(node));
  }

  getRecentRawNodes(limit = 50, options?: { dateStart?: string; dateEnd?: string; app?: string; windowTitle?: string; subtype?: string }) {
    return this.getMemoryNodesByFilters({
      ...options,
      layers: ["RAW"]
    }, limit);
  }

  getRecentEpisodeNodes(limit = 50, options?: { dateStart?: string; dateEnd?: string; app?: string; windowTitle?: string; subtype?: string }) {
    return this.getMemoryNodesByFilters({
      ...options,
      layers: ["EPISODE"]
    }, limit);
  }

  searchRawNodesExact(query: string, limit = 20, filters?: { apps?: string[]; dateStart?: string; dateEnd?: string }) {
    const normalized = String(query || "").trim().toLowerCase();
    if (normalized.length < 4) return [] as MemoryNode[];

    let sql = `SELECT * FROM memory_nodes WHERE layer = 'RAW' AND LOWER(COALESCE(canonical_text, '')) LIKE ?`;
    const params: SqlValue[] = [`%${normalized}%`];

    if (filters?.apps?.length) {
      sql += ` AND json_extract(metadata, '$.app') IN (${filters.apps.map(() => "?").join(", ")})`;
      params.push(...filters.apps);
    }

    if (filters?.dateStart) {
      sql += ` AND anchor_at >= ?`;
      params.push(filters.dateStart);
    }

    if (filters?.dateEnd) {
      sql += ` AND anchor_at <= ?`;
      params.push(filters.dateEnd);
    }

    sql += ` ORDER BY anchor_at DESC LIMIT ?`;
    params.push(limit);
    return this.all(sql, params).map((row) => this.mapMemoryNode(row));
  }

  searchRawNodesByKeywords(keywords: string[], limit = 80, filters?: { subtype?: string; dateStart?: string; dateEnd?: string }) {
    const normalized = Array.from(new Set(
      keywords
        .map((keyword) => String(keyword || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    if (normalized.length === 0) return [] as MemoryNode[];

    const clauses = normalized.map(() => "(LOWER(COALESCE(canonical_text, '')) LIKE ? OR LOWER(COALESCE(title, '')) LIKE ?)");
    const params: SqlValue[] = [];
    for (const keyword of normalized) {
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    let sql = `SELECT * FROM memory_nodes WHERE layer = 'RAW'`;
    if (filters?.subtype) {
      sql += ` AND subtype = ?`;
      params.unshift(filters.subtype);
    }
    if (filters?.dateStart) {
      sql += ` AND anchor_at >= ?`;
      params.push(filters.dateStart);
    }
    if (filters?.dateEnd) {
      sql += ` AND anchor_at <= ?`;
      params.push(filters.dateEnd);
    }
    sql += ` AND (${clauses.join(" OR ")}) ORDER BY anchor_at DESC LIMIT ?`;
    params.push(limit);
    return this.all(sql, params).map((row) => this.mapMemoryNode(row));
  }

  getSurroundingNodes(nodeId: string, depth = 2): MemoryNode[] {
    const target = this.getMemoryNode(nodeId);
    if (!target || !target.anchorAt) return [];

    // Fetch nodes immediately before and after based on timestamp
    const before = this.all(
      `SELECT * FROM memory_nodes WHERE anchor_at < ? AND layer = ? ORDER BY anchor_at DESC LIMIT ?`,
      [target.anchorAt, target.layer, depth]
    ).map(row => this.mapMemoryNode(row)).reverse();

    const after = this.all(
      `SELECT * FROM memory_nodes WHERE anchor_at > ? AND layer = ? ORDER BY anchor_at ASC LIMIT ?`,
      [target.anchorAt, target.layer, depth]
    ).map(row => this.mapMemoryNode(row));

    return [...before, ...after];
  }

  getMemoryEdges(nodeId: string): MemoryEdge[] {
    return this.all(
      `SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ?`,
      [nodeId, nodeId]
    ).map(row => ({
      id: stringValue(row.id),
      fromId: stringValue(row.from_id),
      toId: stringValue(row.to_id),
      relation: stringValue(row.relation),
      weight: numberValue(row.weight),
      metadata: safeJson(stringValue(row.metadata), {})
    }));
  }

  // --- Chat Persistence ---

  createChatSession(title: string): ChatSession {
    const id = createId();
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [id, title, now, now]
    );
    this.persistIfNeeded();
    return { id, title, createdAt: now, updatedAt: now };
  }

  getChatSession(id: string): ChatSession | undefined {
    const row = this.one(`SELECT * FROM chat_sessions WHERE id = ?`, [id]);
    if (!row) return undefined;
    return {
      id: stringValue(row.id),
      title: stringValue(row.title),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at)
    };
  }

  updateChatSessionTitle(id: string, title: string) {
    const now = new Date().toISOString();
    this.run(`UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`, [title, now, id]);
    this.persistIfNeeded();
  }

  deleteChatSession(id: string) {
    // cascade should handle messages if configured, but let's be explicit
    this.run(`DELETE FROM chat_messages WHERE session_id = ?`, [id]);
    this.run(`DELETE FROM chat_sessions WHERE id = ?`, [id]);
    this.persistIfNeeded();
  }

  getChatSessions(): ChatSession[] {
    return this.all(`SELECT * FROM chat_sessions ORDER BY updated_at DESC`).map(row => ({
      id: stringValue(row.id),
      title: stringValue(row.title),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at)
    }));
  }

  addChatMessage(sessionId: string, role: "user" | "assistant", content: string, thinkingTrace?: string, retrievalTrace?: any): string {
    const id = createId();
    const now = new Date().toISOString();
    const ts = Date.now();
    const traceStr = retrievalTrace ? JSON.stringify(retrievalTrace) : null;
    this.run(
      `INSERT INTO chat_messages (id, session_id, role, content, thinking_trace, retrieval_trace, ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sessionId, role, content, thinkingTrace ?? null, traceStr, ts, now]
    );
    this.run(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
    this.persistIfNeeded();
    return id;
  }

  getChatMessages(sessionId: string): ChatMessage[] {
    return this.all(
      `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY ts ASC`,
      [sessionId]
    ).map(row => ({
      id: stringValue(row.id),
      sessionId: stringValue(row.session_id),
      role: stringValue(row.role) as "user" | "assistant",
      content: stringValue(row.content),
      thinkingTrace: optionalString(row.thinking_trace),
      retrievalTrace: row.retrieval_trace ? safeJson(stringValue(row.retrieval_trace), null) : null,
      timestamp: numberValue(row.ts),
      createdAt: stringValue(row.created_at)
    }));
  }

  // --- Utilities ---

  kvSet(key: string, value: any, type?: string) {
    this.kvMemory.set(key, value);
    this.kvLoaded.add(key);
    this.run(
      `INSERT OR REPLACE INTO kv_cache (key, value, type, created_at) VALUES (?, ?, ?, ?)`,
      [key, JSON.stringify(value), type ?? null, new Date().toISOString()]
    );
    this.persistIfNeeded();
  }

  kvGet<T>(key: string): T | undefined {
    if (this.kvLoaded.has(key)) {
      return this.kvMemory.get(key) as T | undefined;
    }
    const row = this.one(`SELECT value FROM kv_cache WHERE key = ?`, [key]);
    const value = row ? safeJson(stringValue(row.value), undefined) : undefined;
    this.kvLoaded.add(key);
    this.kvMemory.set(key, value);
    return value;
  }

  // Blacklist is now managed via SettingsService

  upsertGoogleAccount(input: { email?: string; expiryDate?: number; scopes: string[] }) {
    const now = new Date().toISOString();
    const existing = this.one("SELECT id FROM integration_accounts WHERE provider = 'google' LIMIT 1");
    if (existing) {
      this.run(
        `UPDATE integration_accounts
         SET email = ?, access_token = NULL, refresh_token = NULL, expiry_date = ?, scopes = ?, updated_at = ?
         WHERE id = ?`,
        [input.email ?? null, input.expiryDate ?? null, JSON.stringify(input.scopes), now, existing.id]
      );
    } else {
      this.run(
        `INSERT INTO integration_accounts (id, provider, email, access_token, refresh_token, expiry_date, scopes, created_at, updated_at)
         VALUES (?, 'google', ?, NULL, NULL, ?, ?, ?, ?)`,
        [createId(), input.email ?? null, input.expiryDate ?? null, JSON.stringify(input.scopes), now, now]
      );
    }
    this.persistIfNeeded();
  }

  googleAccount() {
    const row = this.one("SELECT * FROM integration_accounts WHERE provider = 'google' LIMIT 1");
    if (!row) return undefined;
    return {
      email: optionalString(row.email),
      expiry_date: row.expiry_date ? numberValue(row.expiry_date) : undefined,
      last_sync_at: optionalString(row.last_sync_at),
      scopes: stringValue(row.scopes)
    };
  }

  clearGoogleTokens() {
    const now = new Date().toISOString();
    this.run(
      "UPDATE integration_accounts SET access_token = NULL, refresh_token = NULL, updated_at = ? WHERE provider = 'google'",
      [now]
    );
    this.persistIfNeeded();
  }

  markGoogleSynced() {
    const now = new Date().toISOString();
    this.run("UPDATE integration_accounts SET last_sync_at = ?, updated_at = ? WHERE provider = 'google'", [now, now]);
    this.persistIfNeeded();
  }

  setSubsystemHealth(
    subsystem: "capture" | "googleSync" | "appleContacts",
    status: {
      lastSuccessAt?: string;
      lastFailureAt?: string;
      lastFailureMessage?: string;
      lastOcrAt?: string;
      lastIndexedAt?: string;
      cadenceStatus?: string;
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
  ) {
    const current = { ...(this.kvGet<Record<string, any>>("subsystem_health") || {}) };
    current[subsystem] = {
      ...(current[subsystem] || {}),
      ...status
    };
    this.kvSet("subsystem_health", current, "json");
  }

  getSubsystemHealth() {
    return this.kvGet<Record<string, any>>("subsystem_health") || {};
  }

  private mapMemoryNode(row: SqlRow): MemoryNode {
    return {
      id: stringValue(row.id),
      layer: stringValue(row.layer) as MemoryLayer,
      subtype: optionalString(row.subtype),
      title: stringValue(row.title),
      summary: stringValue(row.summary),
      canonicalText: stringValue(row.canonical_text),
      sourceRefs: safeJson(stringValue(row.source_refs), []),
      confidence: numberValue(row.confidence),
      status: stringValue(row.status),
      metadata: safeJson(stringValue(row.metadata), {}),
      importance: numberValue(row.importance),
      connectionCount: numberValue(row.connection_count),
      lastReheated: optionalString(row.last_reheated),
      anchorAt: optionalString(row.anchor_at),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at)
    };
  }

  private seedDefaults() {
    // Intentional no-op. Private beta accounts must start empty.
  }

  deleteAllData() {
    const tables = [
      "events", "memory_nodes", "memory_edges", "text_chunks", 
      "chat_sessions", "chat_messages", "kv_cache", "integration_accounts", "core_identity",
      "memory_nodes_fts", "text_chunks_fts"
    ];
    for (const table of tables) {
      try {
        this.run(`DELETE FROM ${table}`);
      } catch (e) {
        console.warn(`[Database] Failed to clear table ${table}:`, e);
      }
    }
    this.kvMemory.clear();
    this.kvLoaded.clear();
    this.persistIfNeeded();
    console.log("[Database] All data cleared successfully.");
  }

  writeBatch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth = Math.max(0, this.batchDepth - 1);
      if (this.batchDepth === 0) {
        this.persistIfNeeded();
      }
    }
  }

  private run(sql: string, params: SqlValue[] = []) {
    this.sqlite.run(sql, params);
    this.dirty = true;
  }

  private all(sql: string, params: SqlValue[] = []): SqlRow[] {
    const statement = this.sqlite.prepare(sql, params);
    const rows: SqlRow[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as SqlRow);
    statement.free();
    return rows;
  }

  private one(sql: string, params: SqlValue[] = []): SqlRow | undefined {
    return this.all(sql, params)[0];
  }

  private persist() {
    fs.writeFileSync(this.dbPath, Buffer.from(this.sqlite.export()));
    this.dirty = false;
  }

  private persistIfNeeded() {
    if (this.batchDepth > 0 || !this.dirty) return;
    this.persist();
  }
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringValue(value: SqlValue | undefined): string {
  return value == null ? "" : String(value);
}

function optionalString(value: SqlValue | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

function numberValue(value: SqlValue | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
