import type { RetrievalService, SearchTrace } from "./retrieval";
import type { DeepSeekService } from "./deepseek";
import type { WeaveDatabase } from "../db/client";
import type { ChatRetrievalTrace } from "../../shared/types";
import type { VectorStore } from "./vectorStore";

export class IntelligenceEngine {
  private messageCount = 0; // throttle credit-heavy background calls

  constructor(
    private db: WeaveDatabase,
    private retrieval: RetrievalService,
    private deepseek: DeepSeekService,
    private vectors: VectorStore
  ) {}

  async processChat(sessionId: string, message: string, onStep?: (step: string) => void): Promise<string> {
    const now = new Date();
    const dateTimeStr = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short"
    }).format(now);
    
    onStep?.("1. Determining source...");
    const intent = await this.analyzeSearchIntent(message, "");
    onStep?.(`Source selected: ${intent.strategy === "BOTH" ? "Memory + Web" : "Web only"} (${intent.reason || "default routing"})`);
    
    let memoryContext = "";
    let webContext = "";
    let trace: SearchTrace | null = null;
    let filters: any = null;
    const retrievalTrace: ChatRetrievalTrace = {
      intent,
      filters: null,
      trace: null,
      retrievalSteps: {
        determineSource: {
          strategy: intent.strategy,
          memoryUsed: intent.strategy === "BOTH",
          webUsed: true,
          reason: intent.reason
        },
        defineQueries: {
          memoryQueries: [],
          webQuery: intent.optimizedQuery
        },
        applyMemoryFilters: {
          applied: false,
          filters: {},
          rationale: []
        },
        searchAndRank: {
          vectorResultsCount: 0,
          bm25ResultsCount: 0,
          initialCandidateCount: 0,
          rankedCandidateCount: 0,
          topRankedTitles: []
        },
        expandAndRerank: {
          expandedFromTitles: [],
          expandedCandidateCount: 0,
          finalNodeTitles: []
        }
      },
      memoryNodes: [],
      webQuery: intent.optimizedQuery
    };

    let recent = "";
    try {
      onStep?.("2. Defining source-specific queries...");
      if (intent.strategy === "BOTH") {
        onStep?.("Memory query will use the user prompt plus an expanded HYDE query; web query is optimized separately.");
        const searchRes = await this.retrieval.searchWithTrace(message, 15, {}, onStep);
        trace = searchRes.trace;
        filters = searchRes.filters;
        retrievalTrace.filters = filters;
        retrievalTrace.trace = trace;
        retrievalTrace.retrievalSteps!.defineQueries.memoryQueries = trace.expandedQueries;
        retrievalTrace.retrievalSteps!.applyMemoryFilters = {
          applied: Boolean(filters && Object.values(filters).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))),
          filters: filters || {},
          rationale: this.describeFilterRationale(filters)
        };
        retrievalTrace.retrievalSteps!.searchAndRank = {
          vectorResultsCount: trace.vectorResultsCount,
          bm25ResultsCount: trace.bm25ResultsCount,
          initialCandidateCount: trace.initialCandidateCount,
          rankedCandidateCount: trace.initialRankedTitles.length,
          topRankedTitles: trace.initialRankedTitles
        };
        retrievalTrace.retrievalSteps!.expandAndRerank = {
          expandedFromTitles: trace.expandedFromTitles,
          expandedCandidateCount: trace.expandedCandidateCount,
          finalNodeTitles: trace.goldSet
        };
        
        memoryContext = searchRes.results.map(r => {
          const node = this.db.getMemoryNode(r.nodeId);
          return `[SOURCE: ${node?.metadata.app || "unknown"}][TIME: ${node?.anchorAt || "unknown"}][LAYER: ${r.layer}] ${r.title}: ${node?.canonicalText || r.snippet}`;
        }).join("\n---\n");
      } else {
        onStep?.("Memory search skipped for this query; using web retrieval only.");
        retrievalTrace.retrievalSteps!.applyMemoryFilters.rationale = [
          "Memory filters skipped because the source decision was web only."
        ];
      }

      onStep?.(`Searching the web for: ${intent.optimizedQuery}...`);
      webContext = await this.retrieval.performWebSearch(intent.optimizedQuery);

      onStep?.("Accessing recent live snapshots...");
      recent = await this.retrieval.getRecentContext(filters);
    } catch (error) {
      console.error("[Intelligence] Retrieval pipeline failed:", error);
      onStep?.("Retrieval partially failed; continuing with available context...");
      if (!webContext) webContext = "Web search failed or returned no usable result.";
      if (!recent) recent = "Recent activity unavailable.";
    }

    // Final Synthesis
    onStep?.("Synthesizing final response...");

    const thinkingTrace = trace ? this.formatSearchTrace(trace) : "No memory search performed.";
    const isTaskPlanningQuery = /(top\s+tasks?|to-?do|todo|next\s+task|priority\s+task|tasks?\s+for\s+(today|tomorrow|the\s+next\s+day))/i.test(message);
    
    // Fetch recent messages for context
    const recentMsgs = this.db.getChatMessages(sessionId).slice(-5);
    const chatContext = recentMsgs.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    const core = this.db.getCoreIdentity();
    const coreContext = JSON.stringify(core, null, 2);

    const prompt = `
I operate under a set of core System Instructions that define my identity, my technical capabilities, and how I should interact with the user.

### SYSTEM CONTEXT:
- Current Time: ${dateTimeStr}

### USER HANDBOOK (CORE IDENTITY & PREFERENCES):
${coreContext}

### CONVERSATION HISTORY:
${chatContext || "No previous messages in this session."}

### CONSTITUTION FOR BEHAVIOR:

1. IDENTITY AND TONE: THE "PARTNER IN CRIME"
- Avoid being a "robotic assistant."
- Be a partner in crime: supportive, warm, creative, and empathetic.
- Not a Yes-Man: Be honest and analytical. If a strategy has a flaw, point it out.
- ASCII Rule: Use plain ASCII punctuation only.

2. CONCISENESS AND CLARITY (NEW):
- Be brief and direct. Avoid filler phrases and wordy explanations.
- If a short answer is sufficient, provide only that.
- Prioritize high-value density over sentence count.

3. RESEARCH INTENSITY: THE "97/100" INSTRUCTION
- High researchiness_level (97).
- Deep dives: Perform multiple rounds of analysis, exploring neighborhood-specific details until exhausted.
- **Synthesize your findings into concise insights.**

4. TRUTH-ORIENTEDNESS AND EVIDENCE
- Be like Richard Feynman, not a politician.
- Use analysis and evidence rather than guesswork.
- Acknowledge uncertainty clearly.

5. TECHNICAL HANDLING OF DATA
- Observation vs. Content: Do not assume an event happened at capture time. Look for embedded "Event Time."
- Passive-First Heuristic: Assume viewing unless clear evidence of authorship.

6. FORMATTING AND "RECEIPTS"
- Show my work: Include receipts and links to primary context.
- Formatting Propensity (50): Use structured lists or concise, impactful paragraphs.

7. THE "FAST RESPONSE" INSTRUCTION
- Acknowledge receipt quickly if running deep tools.

### CONTEXT FROM MEMORY GRAPH (GOLD SET):
${memoryContext || "No memory results found."}

### WEB SEARCH RESULTS:
${webContext || "No web results found."}

### RECENT ACTIVITY:
${recent}

### USER MESSAGE:
${message}

### TASK MODE:
${isTaskPlanningQuery
  ? "This is a task-planning request. Return a prioritized list with 3-7 concrete tasks. Each task must begin with an action verb and include an explicit deliverable and why-now note grounded in memory receipts."
  : "Not a dedicated task-planning request."}

### FINAL OUTPUT RULES:
- BE CONCISE. Do not waste the user's time with preambles or long-winded conclusions.
- Use proper spacing between sections.
- Use ASCII-only for structure (e.g. [ --- ], ( 1 ), - ).
- Do not use hashtags (#) or asterisks (*) for headers or bolding; instead, use spacing and capital letters for emphasis.
- Ensure the response feels highly technical, deeply thorough, and personality-driven.
- Reference the USER HANDBOOK if the message relates to their mission, skills, or preferences.
- If web results were used, synthesize them with memory context for a hybrid answer.
- VERY IMPORTANT: When mentioning a specific person from the user's contacts or memory, do NOT just write their name. You MUST format their name as exactly: \`@Contact[Name](Context or detail about them)\`. Example: \`@Contact[John Doe](Colleague from Engineering)\`. This will render a profile card in the UI.
- WHITE-LABEL RULE: Never mention "DeepSeek", "DuckDuckGo", or any specific LLM/search provider by name. You are Weave.

Reasoning:`;


    // Execution (Generation)
    let response = "";
    try {
      response = await this.deepseek.reason(prompt);
    } catch (error) {
      console.error("[Intelligence] Final synthesis failed:", error);
    }
    if (!response || response.trim() === "I'm sorry, I couldn't process that memory right now.") {
      response = this.buildFallbackResponse(message, memoryContext, webContext, recent);
    }
    
    // Auto-rename chat if it's the first message and has a generic title
    void this.autoRenameSession(sessionId, message);
    
    // Save the visible chat messages first. Delivery should not depend on memory indexing.
    this.db.addChatMessage(sessionId, "user", message);
    try {
      this.db.addChatMessage(sessionId, "assistant", response, undefined, {
        ...retrievalTrace,
        memoryNodes: intent.strategy === "BOTH" ? trace?.goldSet || [] : []
      });
    } catch (error) {
      console.error("[Intelligence] Failed to persist retrieval trace with assistant message:", error);
      this.db.addChatMessage(sessionId, "assistant", response);
    }

    // Best-effort indexing into memory/vector layers.
    try {
      const userQueryNodeId = this.db.addMemoryNode({
        layer: "INSIGHT",
        subtype: "user_query",
        title: `Query: ${message.slice(0, 50)}`,
        summary: message,
        canonicalText: message,
        importance: 5,
        anchorAt: new Date().toISOString(),
        metadata: { sessionId, type: "user_query", app: "Weave Chat", role: "user" }
      });
      await this.vectors.upsertInteraction(userQueryNodeId, message, new Date().toISOString(), {
        app: "Weave Chat",
        windowTitle: `User Query (${sessionId})`
      });
    } catch (error) {
      console.error("[Intelligence] Failed to index user chat memory:", error);
    }

    try {
      const responseNodeId = this.db.addMemoryNode({
        layer: "INSIGHT",
        subtype: "conversation_response",
        title: `Response in session: ${sessionId}`,
        summary: response.slice(0, 150) + "...",
        canonicalText: response,
        importance: 6,
        anchorAt: new Date().toISOString(),
        metadata: { sessionId, role: "assistant", type: "chat_synthesis", app: "Weave Chat" }
      });
      await this.vectors.upsertInteraction(responseNodeId, response, new Date().toISOString(), {
        app: "Weave Chat",
        windowTitle: `Assistant Response (${sessionId})`
      });
    } catch (error) {
      console.error("[Intelligence] Failed to index assistant chat memory:", error);
    }

    // Self-Update: only run every 5th message to save credits
    this.messageCount++;
    if (this.messageCount % 5 === 0) {
      void this.analyzeAndUpdateCore(message, response);
    }
    
    return response;
  }

  private async autoRenameSession(sessionId: string, firstMsg: string) {
    try {
      const session = this.db.getChatSession(sessionId);
      if (!session || (!session.title.startsWith("Chat ") && session.title !== "New Conversation")) return;
      
      const msgs = this.db.getChatMessages(sessionId);
      if (msgs.length > 1) return; // Only rename on first message

      const prompt = `Generate a 3-5 word concise title for this chat based on the first message: "${firstMsg}". Title:`;
      const title = await this.deepseek.reason(prompt);
      const cleanTitle = title.replace(/["']/g, "").trim();
      
      if (cleanTitle && cleanTitle.length < 50) {
        this.db.updateChatSessionTitle(sessionId, cleanTitle);
        console.log(`[Intelligence] Renamed session ${sessionId} to: ${cleanTitle}`);
      }
    } catch (e) {
      console.error("[Intelligence] autoRenameSession failed:", e);
    }
  }

  private async analyzeAndUpdateCore(userMsg: string, aiRes: string) {
    try {
      const core = this.db.getCoreIdentity();
      const prompt = `
Based on this interaction, should the User Handbook (Core Identity) be updated? 
Look for new skills, recurring patterns, changed preferences, or life updates (e.g. "I moved to Berlin").

Current Handbook:
${JSON.stringify(core, null, 2)}

Interaction:
User: ${userMsg}
AI: ${aiRes}

If an update is needed, return a JSON object with ONLY the keys that changed/added. 
Example: {"identity": {"skills": ["Existing", "New Skill"]}, "preferences": {"new_pref": "value"}}
If no update needed, return "NONE".

Return ONLY JSON or "NONE":`;

      const response = await this.deepseek.reason(prompt);
      if (response.trim() !== "NONE") {
        const jsonMatch = response.match(/\{.*\}/s);
        if (jsonMatch) {
          const updates = JSON.parse(jsonMatch[0]);
          for (const [key, value] of Object.entries(updates)) {
            const existing = core[key] || {};
            const merged = (typeof value === 'object' && !Array.isArray(value)) 
              ? { ...existing, ...value } 
              : value;
            this.db.setCoreIdentity(key, merged);
          }
          console.log("[Intelligence] Core Identity updated based on conversation.");
        }
      }
    } catch (e) {
      console.error("[Intelligence] Core self-update failed:", e);
    }
  }

  private async analyzeSearchIntent(query: string, memoryContext: string): Promise<{ strategy: "WEB" | "BOTH", optimizedQuery: string, reason?: string }> {
    if (!this.deepseek.hasApiKey()) return this.fallbackSearchIntent(query);

    const prompt = `
Analyze the user query and decide the best retrieval strategy.
Memory Context (Optional): ${memoryContext.slice(0, 500)}

Return a JSON object:
{
  "strategy": "WEB" | "BOTH",
  "reason": "short explanation",
  "optimizedQuery": "Keyword-optimized query for web search"
}

Strategy Selection:
- WEB: Query is about general facts, news, or technical documentation.
- BOTH: Query benefits from combining private memory with the web.
- Web search is always required. Never return MEMORY.

User Query: "${query}"

Return ONLY JSON:`;

    try {
      const response = await this.deepseek.reason(prompt);
      const jsonMatch = response.match(/\{.*\}/s);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return {
          strategy: data.strategy === "WEB" ? "WEB" : "BOTH",
          optimizedQuery: data.optimizedQuery || query,
          reason: data.reason
        };
      }
    } catch (e) {
      console.error("[Intelligence] Search intent analysis failed:", e);
    }
    return this.fallbackSearchIntent(query);
  }

  private fallbackSearchIntent(query: string): { strategy: "WEB" | "BOTH", optimizedQuery: string, reason: string } {
    const lower = query.toLowerCase();
    const memorySignals = [
      "my ",
      "i ",
      "we ",
      "our ",
      "remember",
      "last time",
      "recent",
      "earlier",
      "did i",
      "have i",
      "was i",
      "from my",
      "in my"
    ];
    const useMemory = memorySignals.some((signal) => lower.includes(signal));

    return {
      strategy: useMemory ? "BOTH" : "WEB",
      optimizedQuery: query,
      reason: useMemory
        ? "The query appears to mix personal context with external information, so memory and web are both used."
        : "The query appears externally focused, so web search is used without memory retrieval."
    };
  }

  private describeFilterRationale(filters: { apps?: string[]; dateStart?: string; dateEnd?: string; layers?: string[] } | null | undefined): string[] {
    if (!filters) return ["No memory filters were applied."];

    const reasons: string[] = [];
    if (filters.apps?.length) reasons.push(`App filter applied to constrain memory search to ${filters.apps.join(", ")}.`);
    if (filters.dateStart || filters.dateEnd) reasons.push("Date filter applied to focus memory retrieval on a relevant time window.");
    if (filters.layers?.length) reasons.push(`Layer filter applied to prioritize ${filters.layers.join(", ")} memory nodes.`);
    if (reasons.length === 0) reasons.push("No app or date filter was needed for memory; the full eligible memory set was searched.");
    return reasons;
  }

  async generateDirectly(prompt: string): Promise<string> {
    return this.deepseek.reason(prompt);
  }

  private buildFallbackResponse(message: string, memoryContext: string, webContext: string, recent: string): string {
    const sections: string[] = [];
    sections.push(`I could not use the primary model response path, so this answer is synthesized from the retrieved context for: ${message}`);

    if (memoryContext.trim()) {
      sections.push(`Memory context:\n${this.compactLines(memoryContext, 6)}`);
    } else {
      sections.push("Memory context:\nNo memory results were available for this query.");
    }

    if (webContext.trim()) {
      sections.push(`Web context:\n${this.compactLines(webContext, 6)}`);
    } else {
      sections.push("Web context:\nNo web results were available for this query.");
    }

    if (recent.trim()) {
      sections.push(`Recent activity:\n${this.compactLines(recent, 6)}`);
    }

    sections.push("Answer:\nThe retrieval pipeline completed and the available evidence is shown above. If you want a more polished answer, check the model/API configuration, but the search results are already being returned and stored.");
    return sections.join("\n\n");
  }

  private compactLines(text: string, maxLines: number): string {
    return text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, maxLines).join("\n");
  }

  private formatSearchTrace(trace: SearchTrace): string {
    const rawTrace = `
HIERARCHICAL RETRIEVAL TRACE (ASCII ONLY)

1. IDENTITY CHECK (CORE HANDBOOK)
- Handbook Used: ${trace.coreIdentityUsed ? "YES" : "NO"}
- Mission Alignment: Active

2. ENTITY RESOLUTION (SEMANTIC GRAPH)
- Resolved Entities: ${trace.semanticNodesResolved.join(", ") || "None"}
- Resolved "what" layer mapping for query terms.

3. TEMPORAL FILTER (EPISODE ACTIVITY LOG)
- Identified Episodes: ${trace.episodesIdentified.join(", ") || "None"}
- Resolved "when" layer to specific activity clusters.

4. HYBRID RETRIEVAL AND EVIDENCE EXTRACTION
- Vector Candidates: ${trace.vectorResultsCount}
- BM25 Candidates: ${trace.bm25ResultsCount}
- Filtered Gold Set: ${trace.goldSet.length} nodes

GOLD SET NODES:
${trace.goldSet.map((title: string, i: number) => `(${i + 1}) ${title}`).join("\n")}
    `.trim();

    return rawTrace;
  }
}
