import type { WeaveDatabase } from "../db/client";
import type { VectorStore } from "./vectorStore";
import type { SearchResult, MemoryNode, MemoryLayer } from "../../shared/types";
import type { DeepSeekService } from "./deepseek";

export interface SearchFilters {
  apps?: string[];
  dateStart?: string;
  dateEnd?: string;
  layers?: MemoryLayer[];
}

export interface SearchTrace {
  coreIdentityUsed: boolean;
  semanticNodesResolved: string[];
  episodesIdentified: string[];
  expandedQueries: string[];
  vectorResultsCount: number;
  bm25ResultsCount: number;
  nodesAfterFilter: number;
  initialCandidateCount: number;
  initialRankedTitles: string[];
  expandedCandidateCount: number;
  expandedFromTitles: string[];
  goldSet: string[];
}

export class RetrievalService {
  private readonly BROWSER_APPS = ["Google Chrome", "Safari", "Firefox", "Microsoft Edge", "Arc"];

  constructor(
    private db: WeaveDatabase, 
    private vectors: VectorStore,
    private deepseek?: DeepSeekService
  ) {}

  async searchWithTrace(
    query: string, 
    limit = 7, 
    filters?: SearchFilters,
    onStep?: (step: string) => void
  ): Promise<{ results: SearchResult[], trace: SearchTrace, filters: SearchFilters }> {
    const trace: SearchTrace = {
      coreIdentityUsed: false,
      semanticNodesResolved: [],
      episodesIdentified: [],
      expandedQueries: [],
      vectorResultsCount: 0,
      bm25ResultsCount: 0,
      nodesAfterFilter: 0,
      initialCandidateCount: 0,
      initialRankedTitles: [],
      expandedCandidateCount: 0,
      expandedFromTitles: [],
      goldSet: []
    };

    onStep?.("3. Applying memory filters...");
    const core = this.db.getCoreIdentity();
    const analysis = await this.analyzeQueryForFilters(`${query} (Handbook: ${JSON.stringify(core)})`);
    const activeFilters: SearchFilters = { ...analysis, ...filters };
    
    // Default to high-level layers to ensure we hit Episodes and Insights first
    if (!activeFilters.layers || activeFilters.layers.length === 0) {
      activeFilters.layers = ["EPISODE", "INSIGHT", "SEMANTIC"];
    }

    if (activeFilters.apps?.length || activeFilters.dateStart || activeFilters.layers?.length) {
      onStep?.(`Filters active: Apps=[${activeFilters.apps?.join(", ") || "Any"}], Layers=[${activeFilters.layers.join(", ")}], From=${activeFilters.dateStart || "Any"}`);
    }

    onStep?.("2. Defining memory retrieval queries...");
    const hydeAnswer = await this.generateHYDE(query);
    trace.expandedQueries = [query, hydeAnswer];
    onStep?.(`Expanded queries: "${query.slice(0, 30)}..." + HYDE`);
    
    onStep?.("4. Searching memory and ranking initial candidates...");
    let initialCandidates = new Map<string, { node: MemoryNode; score: number }>();
    
    for (const q of [query, hydeAnswer]) {
      const vectorRes = await this.vectors.search(q, 50, {
        apps: activeFilters.apps,
        dateStart: activeFilters.dateStart,
        dateEnd: activeFilters.dateEnd
      });
      trace.vectorResultsCount += vectorRes.length;
      
      const bm25Res = this.db.searchMemoryNodesBM25(q, 50, activeFilters);
      trace.bm25ResultsCount += bm25Res.length;

      this.mergeRRF(initialCandidates, vectorRes, bm25Res);
    }
    
    trace.initialCandidateCount = initialCandidates.size;
    onStep?.(`Found ${initialCandidates.size} initial candidates across all layers.`);

    // Filter to the top 50 initial candidates for Phase D
    let top50 = Array.from(initialCandidates.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    trace.nodesAfterFilter = top50.length;

    onStep?.(`Ranking top ${top50.length} candidates...`);
    const initialRanked = await this.rerank(query, top50, 15); // Rank top 15
    trace.initialRankedTitles = initialRanked.map((res) => res.node.title);

    onStep?.("5. Expanding top memory nodes for more context...");
    const expandedCandidates = new Map<string, { node: MemoryNode; score: number }>();
    
    for (const res of initialRanked) {
      expandedCandidates.set(res.node.id, res);
      // Expand on each of the nodes that you find
      const surrounding = this.db.getSurroundingNodes(res.node.id, 2);
      for (const n of surrounding) {
        if (!expandedCandidates.has(n.id)) {
           expandedCandidates.set(n.id, { node: n, score: res.score * 0.5 }); // Inherit partial score
        }
      }
    }
    
    const candidatesToRerank = Array.from(expandedCandidates.values());
    trace.expandedCandidateCount = candidatesToRerank.length;
    trace.expandedFromTitles = initialRanked.map((res) => res.node.title);
    onStep?.(`Re-ranking expanded set of ${candidatesToRerank.length} nodes...`);
    
    const finalGoldSet = await this.rerank(query, candidatesToRerank, limit);
    trace.goldSet = finalGoldSet.map(g => g.node.title);

    const results: SearchResult[] = finalGoldSet.map(res => ({
      nodeId: res.node.id,
      title: res.node.title,
      snippet: res.node.summary,
      layer: res.node.layer,
      score: res.score,
      metadata: res.node.metadata
    }));

    return { results, trace, filters: activeFilters };
  }

  async search(query: string, limit = 7, filters?: SearchFilters): Promise<SearchResult[]> {
    const { results } = await this.searchWithTrace(query, limit, filters);
    return results;
  }

  private async analyzeQueryForFilters(query: string): Promise<SearchFilters> {
    if (!this.deepseek?.hasApiKey()) return {};
    const prompt = `
You are a precision filter extractor. Convert queries into metadata filters.
Current Time: ${new Date().toISOString()} (${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()})

### Rules:
1. **apps**: Array of application names.
   - Map "email" to ["Mail", "Gmail", "Google Chrome", "Safari"].
   - Map "chat" to ["Slack", "Messages", "Discord", "WhatsApp", "Weave Chat"].
   - IMPORTANT: If any app filter is applied, ALWAYS include the common web browsers in the array too: ["Google Chrome", "Safari"].
2. **dateStart/dateEnd**: Precise ISO-8601 strings for relative time.
3. **layers**: Array of ["RAW", "EPISODE", "SEMANTIC"].

Query: "${query}"

Return ONLY JSON:
{
  "apps": string[] | null,
  "dateStart": string | null,
  "dateEnd": string | null,
  "layers": string[] | null
}`;
    try {
      const res = await this.deepseek.reason(prompt);
      const match = res.match(/\{.*\}/s);
      const data = match ? JSON.parse(match[0]) : {};
      
      // Ensure browsers are always present if apps filter is active
      if (data.apps && data.apps.length > 0) {
        const uniqueApps = new Set([...data.apps, ...this.BROWSER_APPS]);
        data.apps = Array.from(uniqueApps);
      }
      
      return data;
    } catch { return {}; }
  }

  private async generateHYDE(query: string): Promise<string> {
    if (!this.deepseek?.hasApiKey()) return query;
    const prompt = `Generate a hypothetical answer for: "${query}". HYDE Answer:`;
    try {
      return await this.deepseek.reason(prompt);
    } catch { return query; }
  }

  private mergeRRF(candidates: Map<string, { node: MemoryNode; score: number }>, vectorRes: any[], bm25Res: MemoryNode[]) {
    const K = 60;
    vectorRes.forEach((res, rank) => {
      const node = this.db.getMemoryNode(res.nodeId);
      if (node) {
        const cur = candidates.get(node.id) || { node, score: 0 };
        cur.score += 1 / (K + rank + 1);
        candidates.set(node.id, cur);
      }
    });
    bm25Res.forEach((node, rank) => {
      const cur = candidates.get(node.id) || { node, score: 0 };
      cur.score += 1 / (K + rank + 1);
      candidates.set(node.id, cur);
    });
  }

  private async rerank(query: string, candidates: { node: MemoryNode; score: number }[], limit: number): Promise<{ node: MemoryNode; score: number }[]> {
    if (!this.deepseek || candidates.length === 0) return candidates.sort((a,b) => b.score - a.score).slice(0, limit);
    const context = candidates.map((c, i) => `[${i}] ${c.node.title}: ${c.node.summary}`).join("\n");
    const prompt = `Rank these results for: "${query}". Return only the IDs of the top ${limit}.\n\nResults:\n${context}`;
    try {
      const res = await this.deepseek.reason(prompt);
      const ids = res.split(/[\s,]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      const results = ids.map(idx => candidates[idx]).filter(Boolean);
      if (results.length < limit) {
        const remaining = candidates.sort((a,b) => b.score - a.score).filter(c => !results.includes(c));
        results.push(...remaining.slice(0, limit - results.length));
      }
      return results;
    } catch { return candidates.slice(0, limit); }
  }

  async getRecentContext(filters?: SearchFilters): Promise<string> {
    const nodes = this.db.getMemoryNodes();
    let recentNodes = nodes.filter(n => n.layer === "CORE" || n.layer === "INSIGHT" || n.layer === "EPISODE");
    if (filters?.apps?.length) recentNodes = recentNodes.filter(n => filters.apps!.includes(n.metadata.app));
    recentNodes = recentNodes.slice(0, 5);
    const rawEvents = this.db.getRecentEvents(10);
    const filteredEvents = filters?.apps?.length ? rawEvents.filter(e => filters.apps!.some(a => e.source.toLowerCase().includes(a.toLowerCase()))) : rawEvents;
    const rawContext = filteredEvents.map(e => `[RAW][${e.source}][${e.timestamp}] ${e.text?.slice(0, 200)}`).join("\n");
    const nodeContext = recentNodes.map(n => `[${n.layer}] ${n.title}: ${n.summary}`).join("\n");
    return `### RECENT NODES:\n${nodeContext}\n\n### MOST RECENT RAW DATA:\n${rawContext}`;
  }

  async performWebSearch(query: string): Promise<string> {
    try {
      const apiRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
      const data: any = await apiRes.json();
      let results = `### Web Search Results for "${query}":\n`;
      let found = false;
      if (data.AbstractText) { results += `Abstract: ${data.AbstractText}\n`; found = true; }
      if (data.RelatedTopics?.length > 0) {
        data.RelatedTopics.slice(0, 5).forEach((t: any) => { if (t.Text) { results += `- ${t.Text}\n`; found = true; } });
      }
      if (!found) {
        const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await htmlRes.text();
        const snippets = html.match(/<a class="result__snippet".*?>(.*?)<\/a>/g);
        if (snippets) {
          results += "\nDeep Search:\n";
          snippets.slice(0, 5).forEach(s => results += `- ${s.replace(/<[^>]*>/g, '').trim()}\n`);
        }
      }
      return results;
    } catch { return "Web search failed."; }
  }
}
