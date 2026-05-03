import type { WeaveDatabase } from "../db/client";
import type { DeepSeekService } from "./deepseek";

export class ResearchService {
  constructor(
    private db: WeaveDatabase,
    private deepseek?: DeepSeekService,
    private canUseExternalResearch: () => boolean = () => false
  ) {}
  private queue: Array<{ personNodeId: string; name: string }> = [];
  private queuedPersonIds = new Set<string>();
  private inFlightPersonIds = new Set<string>();
  private activeWorkers = 0;
  private readonly MAX_CONCURRENT = 1;
  private readonly MAX_QUEUE_SIZE = 24;
  private readonly MIN_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
  private readonly QUEUE_DELAY_MS = 2500;
  private refreshTimer?: NodeJS.Timeout;

  startBackgroundRefresh() {
    if (this.refreshTimer) return;
    void this.enqueueStalePeopleForRefresh();
    this.refreshTimer = setInterval(() => {
      void this.enqueueStalePeopleForRefresh();
    }, 45 * 60 * 1000);
  }

  async enrichPerson(personNodeId: string, name: string) {
    if (!this.canUseExternalResearch()) return;
    const person = this.db.getMemoryNode(personNodeId);
    if (!person) return;

    const lastAt = String(person.metadata?.webResearchAt || "");
    const lastTs = new Date(lastAt).getTime();
    if (person.metadata?.externalResearch && Number.isFinite(lastTs) && (Date.now() - lastTs) < this.MIN_REFRESH_MS) {
      return;
    }

    if (this.queuedPersonIds.has(personNodeId) || this.inFlightPersonIds.has(personNodeId)) return;
    if (this.queue.length >= this.MAX_QUEUE_SIZE) return;

    this.queue.push({ personNodeId, name });
    this.queuedPersonIds.add(personNodeId);
    if (this.activeWorkers < this.MAX_CONCURRENT) {
      void this.runQueue();
    }
  }

  private async runQueue() {
    if (this.activeWorkers >= this.MAX_CONCURRENT) return;
    this.activeWorkers += 1;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        this.queuedPersonIds.delete(item.personNodeId);
        this.inFlightPersonIds.add(item.personNodeId);
        try {
          await this.enrichPersonNow(item.personNodeId, item.name);
        } finally {
          this.inFlightPersonIds.delete(item.personNodeId);
        }
        await this.yieldToEventLoop();
        await this.delay(this.QUEUE_DELAY_MS);
      }
    } finally {
      this.activeWorkers -= 1;
    }
  }

  private async enrichPersonNow(personNodeId: string, name: string) {
    const node = this.db.getMemoryNode(personNodeId);
    if (!node) return;
    const queries = await this.buildResearchQueries(name, node);
    console.log(`[Research] Enriching profile for ${name} via DuckDuckGo with ${queries.length} queries...`);

    const querySummaries: string[] = [];
    let profilePic: string | undefined;

    try {
      for (const query of queries) {
        const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
        if (!res.ok) continue;
        const data = await res.json();
        
        const abstract = data.AbstractText || "";
        const image = data.Image;
        if (image && !profilePic) profilePic = image;

        const topics = data.RelatedTopics?.map((t: any) => t.Text).filter(Boolean) || [];

        const findings = [
          abstract ? `Background: ${abstract}` : "Background: No direct abstract found.",
          topics.length > 0 ? `Related: ${topics.slice(0, 3).join(" | ")}` : "Related: No high-confidence related topics found."
        ].join("\n");

        querySummaries.push(`Query: ${query}\n${findings}`);
        await this.delay(350);
      }

      console.log(`[Research] Findings generated for ${name}.`);

      const combinedFindings = querySummaries.length > 0
        ? querySummaries.slice(0, 3).join("\n\n")
        : "No high-confidence web findings yet.";

      const { contextualSummary, professionalSummary } = await this.generateAiSummaries(name, node, combinedFindings);

      const metadata = {
        ...node.metadata,
        webSearchQuery: queries[0],
        webQueryPlan: queries,
        externalResearch: combinedFindings,
        researchSummary: contextualSummary,
        professionalSummary: professionalSummary,
        profilePic: profilePic || node.metadata?.profilePic,
        webResearchAt: new Date().toISOString()
      };
      
      const cleanedText = node.canonicalText.replace(/\n\nWEB SEARCH QUERY:[\s\S]*$/m, "");
      const newText = `${cleanedText}\n\nWEB SEARCH QUERY: ${queries.join(" | ")}\nWEB SUMMARY:\n${combinedFindings}\n\nCONTEXT SUMMARY:\n${contextualSummary}`;
      
      this.db.updateMemoryNode(personNodeId, { 
        summary: professionalSummary || node.summary,
        metadata, 
        canonicalText: newText 
      });
        
    } catch (e) {
      console.error(`[Research] Enrichment failed for ${name}:`, e);
    }
  }

  private async generateAiSummaries(name: string, node: any, webFindings: string): Promise<{ contextualSummary: string; professionalSummary: string }> {
    if (!this.deepseek?.hasApiKey()) {
      return { 
        contextualSummary: this.buildContextualSummary(node, webFindings), 
        professionalSummary: node.summary 
      };
    }

    try {
      const prompt = `
Synthesize a professional and contextual summary for a contact based on local memory and web findings.

Person: ${name}
Organization: ${node.metadata?.org || "Unknown"}
Local Memory: ${node.metadata?.localMemorySummary || node.summary}
Web Findings: ${webFindings}

Return a JSON object with:
- "professionalSummary": A concise 1-2 sentence summary of who they are and what they do.
- "contextualSummary": A more detailed paragraph (3-4 sentences) explaining their relevance to the user, combining local interactions with their professional background. Use proper spacing and structure.

Return ONLY JSON:`;

      const response = await this.deepseek.reason(prompt);
      const match = response.match(/\{.*\}/s);
      if (!match) throw new Error("No JSON found");
      const parsed = JSON.parse(match[0]);
      return {
        professionalSummary: parsed.professionalSummary || node.summary,
        contextualSummary: parsed.contextualSummary || this.buildContextualSummary(node, webFindings)
      };
    } catch (e) {
      console.error("[Research] AI Summary generation failed:", e);
      return { 
        contextualSummary: this.buildContextualSummary(node, webFindings), 
        professionalSummary: node.summary 
      };
    }
  }

  private async yieldToEventLoop() {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async enqueueStalePeopleForRefresh() {
    if (!this.canUseExternalResearch()) return;
    const people = this.db.getMemoryNodes("SEMANTIC").filter((node) => node.subtype === "person");
    const due = people
      .filter((person) => {
        const lastAt = String(person.metadata?.webResearchAt || "");
        const ts = new Date(lastAt).getTime();
        if (!person.metadata?.externalResearch) return true;
        if (!Number.isFinite(ts)) return true;
        return (Date.now() - ts) >= this.MIN_REFRESH_MS;
      })
      .slice(0, 2);

    for (const person of due) {
      if (this.queue.length >= this.MAX_QUEUE_SIZE) break;
      if (this.queuedPersonIds.has(person.id) || this.inFlightPersonIds.has(person.id)) continue;
      this.queue.push({ personNodeId: person.id, name: person.title });
      this.queuedPersonIds.add(person.id);
    }

    if (this.queue.length > 0 && this.activeWorkers < this.MAX_CONCURRENT) {
      void this.runQueue();
    }
  }

  private async buildResearchQueries(name: string, node: any): Promise<string[]> {
    const org = String(node.metadata?.org || "").trim();
    const memoryHint = String(node.metadata?.localMemorySummary || node.summary || "").slice(0, 400);
    const defaults = [
      `${name} ${org ? `${org} ` : ""}profile`,
      `${name} ${org ? `${org} ` : ""}recent news`,
      `${name} professional background and role`
    ];

    if (!this.deepseek?.hasApiKey()) {
      return defaults;
    }

    try {
      const prompt = `
Generate 3 concise web-search queries for relationship intelligence research.
Use the same query style you'd use in a chat assistant context: one profile query, one recent-news query, and one context-specific query.

Person: ${name}
Organization: ${org || "Unknown"}
Local memory hint: ${memoryHint || "None"}

Return ONLY JSON array of 3 strings.
`;
      const response = await this.deepseek.reason(prompt);
      const match = response.match(/\[.*\]/s);
      if (!match) return defaults;
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return defaults;
      const queries = parsed.map((value: any) => String(value || "").trim()).filter(Boolean).slice(0, 3);
      return queries.length > 0 ? queries : defaults;
    } catch {
      return defaults;
    }
  }

  private buildContextualSummary(node: any, combinedFindings: string): string {
    const local = String(node.metadata?.localMemorySummary || "").replace(/\s+/g, " ").slice(0, 240);
    const web = String(combinedFindings || "").replace(/\s+/g, " ").slice(0, 360);
    const org = String(node.metadata?.org || "").trim();
    return `Context summary: ${node.title}${org ? ` at ${org}` : ""}. Local memory signals: ${local || "limited local context"}. Web signals: ${web || "limited web context"}.`;
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.queue = [];
    this.queuedPersonIds.clear();
    this.inFlightPersonIds.clear();
  }
}
