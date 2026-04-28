import fs from "node:fs";
import path from "node:path";
import type { SearchResult } from "../../shared/types";

interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  occurredAt: string;
  app?: string;
  windowTitle?: string;
}

export interface VectorFilters {
  dateStart?: string;
  dateEnd?: string;
  apps?: string[];
}

export class VectorStore {
  private records: VectorRecord[] = [];
  private filePath: string;

  constructor(vectorPath: string) {
    fs.mkdirSync(vectorPath, { recursive: true });
    this.filePath = path.join(vectorPath, "interactions.json");
    this.records = this.load();
  }

  async init() {
    // Persistent vector store init
  }

  async upsertInteraction(id: string, text: string, occurredAt: string, metadata?: { app?: string; windowTitle?: string }) {
    // II.1 Semantic Prepending (For the "Math")
    // Prepend metadata into a Human-Readable Header so "Context" is baked into vector coordinates.
    const prependedText = `[APP: ${metadata?.app || "unknown"}][TITLE: ${metadata?.windowTitle || "unknown"}][TIME: ${occurredAt.split("T")[0]}] ${text}`;
    
    const vector = embed(prependedText);
    this.records = this.records.filter((record) => record.id !== id);
    this.records.push({ 
      id, 
      vector, 
      text, 
      occurredAt,
      app: metadata?.app,
      windowTitle: metadata?.windowTitle
    });
    this.save();
  }

  async clearAll() {
    this.records = [];
    this.save();
    console.log("[VectorStore] All semantic records cleared.");
  }

  async search(query: string, limit = 8, filters?: VectorFilters): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    
    // Step 2: Pre-Filtering (The "Hard Gate")
    // Run query against metadata columns BEFORE vector math.
    let candidates = this.records;
    if (filters) {
      if (filters.apps && filters.apps.length > 0) {
        candidates = candidates.filter(r => r.app && filters.apps!.includes(r.app));
      }
      if (filters.dateStart) {
        candidates = candidates.filter(r => r.occurredAt >= filters.dateStart!);
      }
      if (filters.dateEnd) {
        candidates = candidates.filter(r => r.occurredAt <= filters.dateEnd!);
      }
    }

    const queryVector = embed(query);
    return candidates
      .map((record) => ({
        record,
        score: cosine(queryVector, record.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record, score }) => ({
        nodeId: record.id,
        title: record.windowTitle || record.text.slice(0, 80),
        snippet: record.text.slice(0, 260),
        layer: "SEMANTIC" as const,
        score
      }));
  }

  private load(): VectorRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as VectorRecord[];
    } catch {
      return [];
    }
  }

  private save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }
}

function embed(text: string): number[] {
  const vector = new Array(64).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 0;
    for (let index = 0; index < token.length; index += 1) {
      hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
    }
    vector[hash % vector.length] += 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

function cosine(a: number[], b: number[]) {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}
