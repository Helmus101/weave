import type { RetrievalService, SearchTrace } from "./retrieval";
import type { DeepSeekService } from "./deepseek";
import type { WeaveDatabase } from "../db/client";
import type { ChatRetrievalTrace, SourceReceipt } from "../../shared/types";
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
    let memoryReceipts: SourceReceipt[] = [];
    let rawReceipts: SourceReceipt[] = [];
    let webReceipts: SourceReceipt[] = [];
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
      webQuery: intent.optimizedQuery,
      rawNodeIds: [],
      rawEventIds: [],
      webSources: [],
      evidence: {
        sourceMix: [],
        memoryReceipts: [],
        rawReceipts: [],
        webReceipts: []
      }
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
        memoryReceipts = this.retrieval.buildMemoryReceipts(searchRes.results);
        rawReceipts = this.retrieval.buildRawReceipts(searchRes.results);
        
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
      const webResult = await this.retrieval.performWebSearchDetailed(intent.optimizedQuery);
      webContext = webResult.text;
      webReceipts = webResult.receipts;

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

    const core = this.getNormalizedCoreIdentity();
    const coreContext = this.formatCoreContext(core);
    const receiptsSection = this.formatReceiptsForPrompt(memoryReceipts, rawReceipts, webReceipts);
    retrievalTrace.evidence = {
      sourceMix: [
        ...(memoryReceipts.length || rawReceipts.length ? ["memory" as const] : []),
        ...(webReceipts.length ? ["web" as const] : [])
      ],
      memoryReceipts,
      rawReceipts,
      webReceipts
    };
    retrievalTrace.memoryNodes = memoryReceipts.map((receipt) => receipt.title);
    retrievalTrace.rawNodeIds = rawReceipts.map((receipt) => receipt.nodeId).filter(Boolean) as string[];
    retrievalTrace.webSources = webReceipts;

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

### EVIDENCE RECEIPTS:
${receiptsSection}

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
- Include inline receipts when making factual claims, using the evidence labels already provided.
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
      response = this.buildFallbackResponse(message, memoryReceipts, rawReceipts, webReceipts, recent);
    } else {
      response = this.ensureReceiptCoverage(response, memoryReceipts, rawReceipts, webReceipts);
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
        metadata: {
          sessionId,
          role: "assistant",
          type: "chat_synthesis",
          app: "Weave Chat",
          receipts: retrievalTrace.evidence
        },
        sourceRefs: [
          ...(retrievalTrace.rawNodeIds || []),
          ...memoryReceipts.map((receipt) => receipt.nodeId).filter(Boolean) as string[]
        ]
      });
      await this.vectors.upsertInteraction(responseNodeId, response, new Date().toISOString(), {
        app: "Weave Chat",
        windowTitle: `Assistant Response (${sessionId})`
      });
    } catch (error) {
      console.error("[Intelligence] Failed to index assistant chat memory:", error);
    }

    // Self-Update: only run every 5th message to save credits
    this.learnPreferencesFromTurn(message, response);
    this.messageCount++;
    if (this.messageCount % 3 === 0) {
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
      const core = this.getNormalizedCoreIdentity();
      const prompt = `
Based on this interaction, should the User Handbook (Core Identity) be updated? 
Look for new skills, recurring patterns, changed preferences, workflow habits, response-format preferences, or life updates (e.g. "I moved to Berlin").

Current Handbook:
${JSON.stringify(core, null, 2)}

Interaction:
User: ${userMsg}
AI: ${aiRes}

If an update is needed, return a JSON object with ONLY the keys that changed or were added.
Prefer this structure when relevant:
{
  "identity": { "skills": ["..."], "mission": ["..."] },
  "preferences": {
    "communication": { "verbosity": "concise", "tone": ["direct"] },
    "workflow": { "prioritization": ["high conviction"], "automation": ["scheduled briefings"] },
    "routines": { "favorite_briefings": ["Morning Briefing"] }
  }
}
If no update needed, return "NONE".

Return ONLY JSON or "NONE":`;

      const response = await this.deepseek.reason(prompt);
      if (response.trim() !== "NONE") {
        const jsonMatch = response.match(/\{.*\}/s);
        if (jsonMatch) {
          const updates = JSON.parse(jsonMatch[0]) as Record<string, any>;
          const coreMap = core as Record<string, any>;
          for (const [key, value] of Object.entries(updates)) {
            const existing = coreMap[key] || {};
            const merged = this.deepMerge(existing, value);
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

  private buildFallbackResponse(message: string, memoryReceipts: SourceReceipt[], rawReceipts: SourceReceipt[], webReceipts: SourceReceipt[], recent: string): string {
    const sections: string[] = [];
    sections.push(`Primary generation was unavailable, so this answer is built directly from the retrieved evidence for: ${message}`);
    sections.push(`Memory receipts:\n${this.formatReceiptLines([...memoryReceipts, ...rawReceipts], 8) || "No memory receipts were available."}`);
    sections.push(`Web receipts:\n${this.formatReceiptLines(webReceipts, 4) || "No web receipts were available."}`);

    if (recent.trim()) {
      sections.push(`Recent activity:\n${this.compactLines(recent, 6)}`);
    }

    sections.push("Answer:\nThe retrieval pipeline completed and the strongest available receipts are shown above. You can rely on those records even though the primary synthesis path was unavailable.");
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
- Raw Evidence Nodes: ${trace.rawEvidenceCount || 0}
- Exact Raw Matches: ${trace.exactMatchCount || 0}
- Timeline Expansions: ${trace.timelineExpansionCount || 0}
- Coverage: ${trace.coverageSummary || "unknown"}

GOLD SET NODES:
${trace.goldSet.map((title: string, i: number) => `(${i + 1}) ${title}`).join("\n")}
    `.trim();

    return rawTrace;
  }

  private formatReceiptsForPrompt(memoryReceipts: SourceReceipt[], rawReceipts: SourceReceipt[], webReceipts: SourceReceipt[]) {
    const memory = this.formatReceiptLines(memoryReceipts, 5) || "No high-level memory receipts.";
    const raw = this.formatReceiptLines(rawReceipts, 5) || "No raw OCR receipts.";
    const web = this.formatReceiptLines(webReceipts, 5) || "No web receipts.";
    return `MEMORY:\n${memory}\n\nRAW:\n${raw}\n\nWEB:\n${web}`;
  }

  private formatReceiptLines(receipts: SourceReceipt[], limit: number) {
    return receipts.slice(0, limit).map((receipt) => {
      if (receipt.kind === "web") {
        return `[Web][${receipt.title}] ${receipt.snippet}${receipt.url ? ` (${receipt.url})` : ""}`;
      }
      return `[Memory][${receipt.app || receipt.layer || "unknown"}][${receipt.timestamp || "unknown"}] ${receipt.title}: ${receipt.snippet}`;
    }).join("\n");
  }

  private ensureReceiptCoverage(response: string, memoryReceipts: SourceReceipt[], rawReceipts: SourceReceipt[], webReceipts: SourceReceipt[]) {
    const hasReceiptMarkers = response.includes("[Memory]") || response.includes("[Web]");
    if (hasReceiptMarkers) return response;
    const receiptSection = [
      this.formatReceiptLines([...memoryReceipts, ...rawReceipts], 4),
      this.formatReceiptLines(webReceipts, 2)
    ].filter(Boolean).join("\n");
    if (!receiptSection) return response;
    return `${response}\n\nRECEIPTS\n${receiptSection}`;
  }

  private getNormalizedCoreIdentity() {
    const raw = this.db.getCoreIdentity() || {};
    return {
      identity: raw.identity || {},
      preferences: {
        communication: raw.preferences?.communication || {},
        workflow: raw.preferences?.workflow || {},
        routines: raw.preferences?.routines || {},
        product: raw.preferences?.product || {}
      },
      preferenceSignals: Array.isArray(raw.preferenceSignals) ? raw.preferenceSignals.slice(-25) : [],
      contextDefaults: raw.contextDefaults || {}
    };
  }

  private formatCoreContext(core: Record<string, any>) {
    const lines: string[] = [];
    const identity = core.identity || {};
    const preferences = core.preferences || {};
    const communication = preferences.communication || {};
    const workflow = preferences.workflow || {};
    const routines = preferences.routines || {};
    const product = preferences.product || {};
    const signals = Array.isArray(core.preferenceSignals) ? core.preferenceSignals.slice(-10) : [];

    lines.push("IDENTITY");
    lines.push(JSON.stringify(identity, null, 2));
    lines.push("");
    lines.push("ACTIVE PREFERENCES");
    lines.push(JSON.stringify({
      communication,
      workflow,
      routines,
      product
    }, null, 2));
    if (signals.length > 0) {
      lines.push("");
      lines.push("RECENT LEARNED SIGNALS");
      for (const signal of signals) {
        lines.push(`- [${signal.kind || "general"}][${signal.confidence || "medium"}] ${signal.text}`);
      }
    }
    return lines.join("\n");
  }

  private learnPreferencesFromTurn(userMsg: string, aiRes: string) {
    try {
      const core = this.getNormalizedCoreIdentity();
      const updates = this.extractDeterministicPreferenceUpdates(userMsg, aiRes);
      if (!updates) return;

      if (updates.communication) {
        const merged = this.deepMerge(core.preferences.communication || {}, updates.communication);
        this.db.setCoreIdentity("preferences", this.deepMerge(core.preferences, { communication: merged }));
      }
      if (updates.workflow) {
        const current = this.getNormalizedCoreIdentity();
        this.db.setCoreIdentity("preferences", this.deepMerge(current.preferences, { workflow: updates.workflow }));
      }
      if (updates.routines) {
        const current = this.getNormalizedCoreIdentity();
        this.db.setCoreIdentity("preferences", this.deepMerge(current.preferences, { routines: updates.routines }));
      }
      if (updates.product) {
        const current = this.getNormalizedCoreIdentity();
        this.db.setCoreIdentity("preferences", this.deepMerge(current.preferences, { product: updates.product }));
      }
      if (updates.signals.length > 0) {
        const current = this.getNormalizedCoreIdentity();
        const existingSignals = Array.isArray(current.preferenceSignals) ? current.preferenceSignals : [];
        const mergedSignals = [...existingSignals, ...updates.signals].slice(-40);
        this.db.setCoreIdentity("preferenceSignals", mergedSignals);
      }
    } catch (error) {
      console.error("[Intelligence] Deterministic preference learning failed:", error);
    }
  }

  private extractDeterministicPreferenceUpdates(userMsg: string, _aiRes: string) {
    const text = userMsg.trim();
    const lower = text.toLowerCase();
    const signals: Array<Record<string, any>> = [];
    const communication: Record<string, any> = {};
    const workflow: Record<string, any> = {};
    const routines: Record<string, any> = {};
    const product: Record<string, any> = {};

    const recordSignal = (kind: string, extracted: string, confidence: "high" | "medium" = "high") => {
      signals.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        text: extracted,
        confidence,
        observedAt: new Date().toISOString()
      });
    };

    if (/\b(be|keep|make it|make sure|please be)\b.*\b(concise|brief|short|direct)\b/i.test(text)) {
      communication.verbosity = "concise";
      recordSignal("communication", "User prefers concise, direct answers.");
    }
    if (/\b(in depth|detailed|thorough|deep)\b/i.test(text)) {
      communication.depth = "detailed";
      recordSignal("communication", "User sometimes requests detailed, in-depth output.", "medium");
    }
    if (/\bprofessional\b/i.test(text)) {
      communication.tone = Array.from(new Set([...(communication.tone || []), "professional"]));
      recordSignal("communication", "User prefers professional output style.");
    }
    if (/\bexecutive\b|\bchief of staff\b/i.test(text)) {
      workflow.prioritizationStyle = "executive";
      recordSignal("workflow", "User wants an executive or chief-of-staff style assistant.");
    }
    if (/\bproactive\b/i.test(text)) {
      workflow.assistantMode = "proactive";
      recordSignal("workflow", "User wants stronger proactive guidance.");
    }
    if (/\broutine|briefing|daily brief|morning briefing\b/i.test(text)) {
      routines.prefersScheduledBriefings = true;
      recordSignal("routines", "User values scheduled routines and briefings.", "medium");
    }
    if (/\breceipts|sources|source-grounded|evidence\b/i.test(text)) {
      product.answerStyle = "evidence_first";
      recordSignal("product", "User prefers source-grounded answers with evidence.");
    }
    if (/\bui\b|\bux\b|\bdashboard\b/i.test(text)) {
      product.uiPreference = "premium_dashboard";
      recordSignal("product", "User values polished UI and dashboard-style presentation.", "medium");
    }

    const explicitPreferenceMatch = text.match(/\b(i prefer|i like|i want|make sure|please)\b(.+)/i);
    if (explicitPreferenceMatch) {
      recordSignal("explicit", explicitPreferenceMatch[0].trim(), "high");
    }

    const hasUpdates = Object.keys(communication).length || Object.keys(workflow).length || Object.keys(routines).length || Object.keys(product).length || signals.length;
    if (!hasUpdates) return null;
    return { communication, workflow, routines, product, signals };
  }

  private deepMerge(existing: any, incoming: any): any {
    if (Array.isArray(existing) && Array.isArray(incoming)) {
      return Array.from(new Set([...existing, ...incoming]));
    }
    if (this.isPlainObject(existing) && this.isPlainObject(incoming)) {
      const merged: Record<string, any> = { ...existing };
      for (const [key, value] of Object.entries(incoming)) {
        merged[key] = key in merged ? this.deepMerge(merged[key], value) : value;
      }
      return merged;
    }
    return incoming;
  }

  private isPlainObject(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}
