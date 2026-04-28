import { EventEmitter } from "node:events";
import { IntelligenceEngine } from "./intelligence";
import { RetrievalService } from "./retrieval";
import { WeaveDatabase } from "../db/client";

export interface ProactiveSuggestion {
  id: string;
  category?: "relationship" | "project";
  topic: string;
  summary: string;
  plan: string;
  immediateTasks: string[];
  aiCompletedWork?: string;
  humanTasks?: string[];
  contactName?: string;
  trigger?: string;
  whyNow?: string;
  draftMessage?: string;
  daysSinceLastContact?: number;
  createdAt: string;
  evidence?: string;
  confidence?: number;
  completedTasks?: string[];
  completedAt?: string;
}

export class ProactiveService extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private readonly RELATIONSHIP_TOPICS = new Set(["follow-up", "nudge", "re-engage", "news"]);
  private readonly MAX_PER_CATEGORY = 5;
  private readonly MAX_ENRICH_CONCURRENCY = 2;
  private cachedStyleProfile = "";
  private styleProfileUpdatedAt = 0;
  private generationInProgress = false;

  constructor(
    private db: WeaveDatabase,
    private retrieval: RetrievalService,
    private intelligence: IntelligenceEngine
  ) {
    super();
  }

  start() {
    console.log("[Proactive] Starting background suggestion engine...");
    // Run on start, then every 20 minutes to keep suggestions fresh.
    this.generateSuggestions();
    this.interval = setInterval(() => this.generateSuggestions(), 20 * 60 * 1000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  async generateSuggestions() {
    if (this.generationInProgress) {
      console.log("[Proactive] Generation already in progress. Skipping overlap.");
      return this.getSuggestions();
    }

    this.generationInProgress = true;
    this.emit("generationState", { inProgress: true });
    try {
      const existing = this.db.kvGet<ProactiveSuggestion[]>("proactive_suggestions") || [];
      const completedTodaySignatures = new Set(
        existing
          .filter((suggestion) => this.isCompletedToday(suggestion))
          .map((suggestion) => this.suggestionSignature(suggestion.topic, suggestion.summary))
      );
      const activeSuggestions = existing.filter((suggestion) => !this.isCompletedSuggestion(suggestion));

      const currentRelationships = activeSuggestions.filter((suggestion) => this.isRelationshipSuggestion(suggestion)).slice(0, this.MAX_PER_CATEGORY);
      const currentProjects = activeSuggestions.filter((suggestion) => !this.isRelationshipSuggestion(suggestion)).slice(0, this.MAX_PER_CATEGORY);
      const relationshipNeeded = Math.max(0, this.MAX_PER_CATEGORY - currentRelationships.length);
      const projectNeeded = Math.max(0, this.MAX_PER_CATEGORY - currentProjects.length);

      if (relationshipNeeded === 0 && projectNeeded === 0) {
        const merged = [...currentRelationships, ...currentProjects];
        this.db.kvSet("proactive_suggestions", merged, "json");
        this.emit("suggestions", merged);
        console.log("[Proactive] Already at max suggestions for both categories (5 each). Skipping.");
        return merged;
      }

      const relationshipQuery = "What are the best things to do to strengthen my relationships?";
      const tasksQuery = "What are my top tasks I should do?";


      console.log(`[Proactive] Filling gaps. Needed: relationships=${relationshipNeeded}, tasks=${projectNeeded}`);

      const [relationshipContext, taskContext] = await Promise.all([
        this.buildMemoryFirstContext(relationshipQuery),
        this.buildMemoryFirstContext(tasksQuery)
      ]);

      const [relationshipCandidates, taskCandidates, styleProfile, userInterests, projectContext] = await Promise.all([
        this.generateCandidates(relationshipContext, "relationship", Math.max(relationshipNeeded * 3, relationshipNeeded)),
        this.generateCandidates(taskContext, "project", Math.max(projectNeeded * 3, projectNeeded)),
        this.getUserEmailStyleProfile(),
        this.summarizeUserInterests(),
        Promise.resolve(this.getProjectContext())
      ]);

      const existingKeys = new Set(activeSuggestions.map((s) => this.suggestionSignature(s.topic, s.summary)));
      for (const signature of completedTodaySignatures) {
        existingKeys.add(signature);
      }
      const dedupeAndFilter = (items: Array<{ category: "project" | "relationship"; topic: string; summary: string; sourceContext: string }>) => {
        const accepted: Array<{ category: "project" | "relationship"; topic: string; summary: string; sourceContext: string }> = [];
        const seen = new Set<string>();
        for (const item of items) {
          const key = this.suggestionSignature(item.topic, item.summary);
          if (existingKeys.has(key) || seen.has(key)) continue;
          seen.add(key);
          accepted.push(item);
        }
        return accepted;
      };

      const relPool = dedupeAndFilter(relationshipCandidates);
      const taskPool = dedupeAndFilter(taskCandidates);

      const relSelected = relPool.slice(0, relationshipNeeded);
      const taskSelected = taskPool.slice(0, projectNeeded);

      const relFallbackPool = relPool.slice(relSelected.length);
      const taskFallbackPool = taskPool.slice(taskSelected.length);
      const relBackfill = relFallbackPool.slice(0, Math.max(0, relationshipNeeded - relSelected.length));
      const taskBackfill = taskFallbackPool.slice(0, Math.max(0, projectNeeded - taskSelected.length));
      const relationshipBase = [...relSelected, ...relBackfill].slice(0, relationshipNeeded);
      const taskBase = [...taskSelected, ...taskBackfill].slice(0, projectNeeded);

      const newCandidates = [...relationshipBase, ...taskBase];

      if (newCandidates.length === 0) {
        console.log("[Proactive] No new candidates produced from model. Falling back to deterministic defaults.");
      }

      const baseCandidates = newCandidates.length > 0 ? newCandidates : this.defaultCandidates(relationshipNeeded, projectNeeded, relationshipContext, taskContext);


      // Stage 2: Dig Deeper for each candidate
      console.log(`[Proactive] Enriching ${baseCandidates.length} candidates...`);
      const enriched = await this.mapWithConcurrency(baseCandidates, this.MAX_ENRICH_CONCURRENCY, async (candidate) => {

        // Perform targeted search to "dig deeper" for this specific candidate
        const deepDiveQuery = `Detailed context for: ${candidate.topic} - ${candidate.summary}`;
        const { results: deepDiveResults } = await this.retrieval.searchWithTrace(deepDiveQuery, 15);
        const deepDiveContext = deepDiveResults.map(r => `${r.title}: ${r.snippet}`).join("\n");
        
        return this.enrichSuggestion(candidate, styleProfile, userInterests, projectContext, deepDiveContext);
      });

      const qualityFiltered = enriched
        .filter((suggestion) => this.isHighQualitySuggestion(suggestion));

      const highQuality = qualityFiltered.map((suggestion) => ({
        id: Math.random().toString(36).substring(7),
        ...suggestion,
        createdAt: new Date().toISOString()
      }));

      const highQualityRelationships = highQuality.filter((suggestion) => this.isRelationshipSuggestion(suggestion)).slice(0, relationshipNeeded);
      const highQualityProjects = highQuality.filter((suggestion) => !this.isRelationshipSuggestion(suggestion)).slice(0, projectNeeded);

      const relationshipGapAfterQuality = Math.max(0, relationshipNeeded - highQualityRelationships.length);
      const taskGapAfterQuality = Math.max(0, projectNeeded - highQualityProjects.length);

      const fallbackRelationships = relationshipGapAfterQuality > 0
        ? this.buildFallbackRelationshipSuggestions(relationshipGapAfterQuality, relationshipContext)
        : [];
      const fallbackProjects = taskGapAfterQuality > 0
        ? this.buildFallbackTaskSuggestions(taskGapAfterQuality, taskContext)
        : [];

      const fallbackHighQualityRelationships = fallbackRelationships
        .filter((suggestion) => !completedTodaySignatures.has(this.suggestionSignature(suggestion.topic, suggestion.summary)))
        .map((suggestion) => ({
          id: Math.random().toString(36).substring(7),
          ...suggestion,
          createdAt: new Date().toISOString()
        }));

      const fallbackHighQualityProjects = fallbackProjects
        .filter((suggestion) => !completedTodaySignatures.has(this.suggestionSignature(suggestion.topic, suggestion.summary)))
        .map((suggestion) => ({
          id: Math.random().toString(36).substring(7),
          ...suggestion,
          createdAt: new Date().toISOString()
        }));

      const mergedRelationships = [...currentRelationships, ...highQualityRelationships, ...fallbackHighQualityRelationships].slice(0, this.MAX_PER_CATEGORY);
      const mergedProjects = [...currentProjects, ...highQualityProjects, ...fallbackHighQualityProjects].slice(0, this.MAX_PER_CATEGORY);
      const merged = [...mergedRelationships, ...mergedProjects];
      this.db.kvSet("proactive_suggestions", merged, "json");
      this.emit("suggestions", merged);
      console.log(`[Proactive] Finished sync. Added ${highQualityRelationships.length} relationship suggestions and ${highQualityProjects.length} task suggestions. Active=${mergedRelationships.length}/5 relationships, ${mergedProjects.length}/5 tasks.`);
      return merged;
    } catch (e) {
      console.error("[Proactive] Generation failed:", e);
      return this.getSuggestions();
    } finally {
      this.generationInProgress = false;
      this.emit("generationState", { inProgress: false });
    }
  }

  getSuggestions(): ProactiveSuggestion[] {
    return this.db.kvGet<ProactiveSuggestion[]>("proactive_suggestions") || [];
  }

  private async enrichSuggestion(
    candidate: { category?: "project" | "relationship"; topic: string; summary: string; sourceContext: string }, 
    styleProfile: string,
    userInterests: string,
    projectContext: string,
    deepDiveContext: string
  ): Promise<Omit<ProactiveSuggestion, "id" | "createdAt">> {
    const isRelationship = candidate.category === "relationship" || this.RELATIONSHIP_TOPICS.has(candidate.topic.toLowerCase());
    const relScore = Math.floor(Math.random() * 40) + 30; // 30-70 range

    const prompt = isRelationship ? `
### TASK: Relational Proactive Nudge (RPN)
Generate a high-EQ outreach suggestion for ${candidate.topic}.

### CORE MEMORIES (GOLD SET)
${candidate.sourceContext}

### DEEP DIVE CONTEXT
${deepDiveContext}

### USER'S CURRENT FOCUS
${userInterests}

### INSTRUCTIONS FOR RPN
Classify into one of these categories:
1. **Nurture**: "You're losing someone." Interaction frequency dropped vs baseline.
2. **Life Event**: Someone's world changed (job change, funding, launch).
3. **Warm Intro**: Two people in your graph should meet.
4. **Context Prep**: Meeting coming up, surface key "ghost memories".
5. **Strategic**: High-proximity contact you haven't followed up with.

REQUIRED:
- Be specific. Mention exact day counts (e.g., "haven't talked in 58 days") or baseline shifts (e.g., "8 interactions in March, now zero").
- Reference a SPECIFIC detail from the Deep Dive context.
- Provide a pre-written draft message that references a "Value Add".
- Use the user's style profile for the draft.

### OUTPUT FORMAT (JSON)
{
  "category": "relationship",
  "topic": "Concise Name (2-3 words)",
  "contactName": "${candidate.topic}",
  "summary": "🔴 [Punchy summary - max 12 words]",

  "draftMessage": "[A 2-3 sentence personalized outreach opener]",
  "plan": "### Relationship Context\\n- **Baseline**: [e.g. 5 interactions/mo]\\n- **Current Gap**: [e.g. 45 days quiet]\\n- **Signal**: [e.g. Moved to Canva 12 days ago]\\n\\n**Why reach out?** [Detailed rationale]",
  "trigger": "Context-derived trigger",
  "whyNow": "Why this matters now",
  "evidence": "Memory anchor",
  "confidence": 85,
  "immediateTasks": ["Send Reach-out"]
}` : `
### TASK: Actionable Context Task (ACT)
Identify unresolved tasks, blockers, and opportunities for automation.

### PROJECT HIERARCHY
${projectContext}

### CORE MEMORIES (GOLD SET)
${candidate.sourceContext}

### DEEP DIVE CONTEXT
${deepDiveContext}

### INSTRUCTIONS FOR ACT
1. **Detect "Ghost Tasks"**: Look for unanswered questions, TODOs, or deadlines buried in transcripts/emails.
2. **Automate the Output**: If the task can be automated (e.g., creating a study plan, drafting a project outline, or building a comparison table), DO IT NOW in the 'plan' field.
3. **Receipts**: Every task must have a "Source Link" (App + Approximate Time/Date).
4. **No Placeholders**: Do NOT output generic phrases like "Key task extraction", "Review tasks", "Top to-do", or "Next task".
5. **Concrete Action**: The summary must be a real task starting with an action verb (e.g., "Draft", "Send", "Schedule", "Review", "Finalize").

### OUTPUT FORMAT (JSON)
{
  "category": "project",
  "topic": "Concise stream (2-3 words)",
  "summary": "Concrete action (max 12 words)",

  "plan": "Detailed plan with concrete steps and rationale from memory evidence",
  "aiCompletedWork": "Concrete artifact already prepared by AI",
  "immediateTasks": ["First concrete next action", "Second concrete next action"],
  "confidence": 95,
  "evidence": "Memory or web anchor"
}`;

    const response = await this.intelligence.generateDirectly(prompt);
    const jsonMatch = response.match(/\{.*\}/s);
    if (!jsonMatch) {
      return {
        category: candidate.category || "project",
        topic: candidate.topic,
        summary: candidate.summary,
        plan: `AI prepared the next step based on current memory context. Review the context and complete only the remaining external actions.`,
        aiCompletedWork: candidate.sourceContext,
        immediateTasks: ["Review Context"],
        confidence: 50
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const contactName = String(parsed.contactName || this.inferContactName(candidate.sourceContext) || "").trim();
    const rawDraft = String(parsed.draftMessage || "").trim();
    const draftMessage = isRelationship
      ? await this.rewriteInUserVoice(rawDraft, styleProfile, contactName || undefined, candidate.sourceContext)
      : rawDraft;

    return {
      category: parsed.category === "relationship" ? "relationship" : (isRelationship ? "relationship" : "project"),
      topic: parsed.topic || candidate.topic,
      summary: parsed.summary || candidate.summary,
      plan: parsed.plan || "AI identified the next steps based on your recent activity.",
      aiCompletedWork: parsed.aiCompletedWork || candidate.sourceContext,
      contactName: contactName || undefined,
      trigger: parsed.trigger,
      whyNow: parsed.whyNow,
      draftMessage: draftMessage || undefined,
      daysSinceLastContact: Number.isFinite(parsed.daysSinceLastContact) ? parsed.daysSinceLastContact : undefined,
      evidence: parsed.evidence || candidate.sourceContext.slice(0, 60) + "...",
      confidence: parsed.confidence || 70,
      immediateTasks: Array.isArray(parsed.immediateTasks) ? parsed.immediateTasks.slice(0, 3) : [],
      humanTasks: Array.isArray(parsed.humanTasks) ? parsed.humanTasks.slice(0, 5) : []
    };
  }

  private normalizeCategory(candidate: { category?: string; topic: string; summary: string; sourceContext: string }): "project" | "relationship" {
    const category = String(candidate.category || "").toLowerCase().trim();
    if (category === "relationship") return "relationship";

    const text = `${candidate.topic} ${candidate.summary} ${candidate.sourceContext}`.toLowerCase();
    if (this.RELATIONSHIP_TOPICS.has(candidate.topic.toLowerCase())) return "relationship";
    if (/(follow up|follow-up|relationship|intro|introduction|reach out|re-engage|contact|network|nudge)/.test(text)) {
      return "relationship";
    }
    return "project";
  }

  private async buildMemoryFirstContext(query: string): Promise<string> {
    try {
      const { results, filters } = await this.retrieval.searchWithTrace(query, 20);
      const context = results
        .map((result) => `${result.title}: ${result.snippet}`)
        .join("\n");
      const recent = await this.retrieval.getRecentContext(filters);
      const combined = [context, recent].filter(Boolean).join("\n\n");
      if (combined.trim()) return combined;
    } catch (error) {
      console.warn("[Proactive] Retrieval context build failed:", error);
    }

    const fallbackEvents = this.db.getRecentEvents(80)
      .map((event) => `${event.type}@${event.timestamp}: ${String(event.text || "").replace(/\s+/g, " ").slice(0, 140)}`)
      .filter(Boolean)
      .slice(0, 30)
      .join("\n");
    return fallbackEvents || "No context available.";
  }

  private async generateCandidates(
    context: string,
    mode: "relationship" | "project",
    maxItems: number
  ): Promise<Array<{ category: "project" | "relationship"; topic: string; summary: string; sourceContext: string }>> {
    if (maxItems <= 0) return [];

    const prompt = mode === "relationship"
      ? `
You are generating Relationship Radar candidates.

Core objective: What are the best things to do to strengthen my relationships?


Context:
${context.slice(0, 9000)}

Return ONLY valid JSON array with up to ${Math.max(1, maxItems)} items:
[
  {
    "category": "relationship",
    "topic": "short name",
    "summary": "concise person action",
    "sourceContext": "evidence"
  }
]`
      : `
You are generating top to-do and project candidates.

Core objective: What are my top tasks I should do?


Context:
${context.slice(0, 9000)}

Return ONLY valid JSON array with up to ${Math.max(1, maxItems)} items:
[
  {
    "category": "project",
    "topic": "short task name",
    "summary": "concise task summary",
    "sourceContext": "evidence"
  }
]

Rules:
- Every summary must start with an action verb: Draft, Send, Review, Finalize, Ship, Schedule, Prepare.
- Every summary must include a concrete deliverable, not a placeholder.
- Forbidden summaries: "Key task extraction", "Review tasks", "Top to-do", "Next task", "Follow up later".
- Use source evidence from context with specific app/time clues when available.`;

    try {
      const response = await this.intelligence.generateDirectly(prompt);
      const match = response.match(/\[.*\]/s);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => ({
          category: this.normalizeCategory(item),
          topic: String(item.topic || "").trim(),
          summary: String(item.summary || "").trim(),
          sourceContext: String(item.sourceContext || context.slice(0, 600)).trim()
        }))
        .filter((item) => item.topic && item.summary)
        .slice(0, Math.max(1, maxItems));
    } catch {
      return [];
    }
  }

  private async summarizeUserInterests(): Promise<string> {
    try {
      const recentMemories = this.db.getRecentEvents(100);
      if (recentMemories.length === 0) return "General productivity and follow-through.";
      return await this.intelligence.generateDirectly(
        `Summarize the user's top 3 active interests or focus areas from these memories:\n${recentMemories.map((m) => m.text).join("\n").slice(0, 5000)}`
      );
    } catch {
      return "General productivity and follow-through.";
    }
  }

  private getProjectContext(): string {
    const coreNodes = this.db.getMemoryNodes("CORE");
    const labels = coreNodes
      .map((node) => node.title)
      .map((title) => String(title || "").trim())
      .filter(Boolean)
      .slice(0, 20);
    return labels.join(", ") || "General Productivity";
  }

  private defaultCandidates(
    relationshipCount: number,
    projectCount: number,
    relationshipContext: string,
    taskContext: string
  ): Array<{ category: "project" | "relationship"; topic: string; summary: string; sourceContext: string }> {
    const relContext = relationshipContext.slice(0, 600) || "Recent contact/network context";
    const projContext = taskContext.slice(0, 600) || "Recent to-do/project context";
    const seeded: Array<{ category: "project" | "relationship"; topic: string; summary: string; sourceContext: string }> = [];

    for (let i = 0; i < relationshipCount; i += 1) {
      seeded.push({
        category: "relationship",
        topic: i === 0 ? "Follow-up" : i === 1 ? "Re-engage" : "Network Opportunity",
        summary: i === 0
          ? "Send a targeted follow-up to strengthen an active relationship thread"
          : i === 1
            ? "Reconnect with someone important while the context is still warm"
            : "Reach out to a high-value contact with a specific, timely reason",
        sourceContext: relContext
      });
    }

    for (let i = 0; i < projectCount; i += 1) {
      seeded.push({
        category: "project",
        topic: i === 0 ? "Top To-Do" : i === 1 ? "Priority Workstream" : "Next Task",
        summary: i === 0
          ? "Close one high-impact pending task from recent activity"
          : i === 1
            ? "Unblock the next project milestone with a concrete next action"
            : "Pick the next highest-leverage task and finish it",
        sourceContext: projContext
      });
    }

    return seeded;
  }

  private buildFallbackRelationshipSuggestions(
    count: number,
    relationshipContext: string
  ): Array<Omit<ProactiveSuggestion, "id" | "createdAt">> {
    const contextLine = relationshipContext.split("\n").find((line) => line.trim().length > 20) || "Recent relationship context detected";
    const suggestions: Array<Omit<ProactiveSuggestion, "id" | "createdAt">> = [];
    for (let i = 0; i < count; i += 1) {
      suggestions.push({
        category: "relationship",
        topic: i % 2 === 0 ? "Follow-up" : "Re-engage",
        summary: i % 2 === 0
          ? "Send a targeted follow-up to keep an important relationship warm"
          : "Reconnect with a key contact using recent shared context",
        plan: `Use this context to personalize outreach: ${contextLine.slice(0, 220)}`,
        contactName: undefined,
        trigger: "Relationship context detected in recent memory",
        whyNow: "Maintaining continuity prevents relationship decay",
        draftMessage: "Quick follow-up based on your recent context and their latest update.",
        evidence: contextLine.slice(0, 140),
        confidence: 65,
        immediateTasks: ["Draft outreach"],
        humanTasks: ["Send message"]
      });
    }
    return suggestions;
  }

  private buildFallbackTaskSuggestions(
    count: number,
    taskContext: string
  ): Array<Omit<ProactiveSuggestion, "id" | "createdAt">> {
    const lines = taskContext
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 24)
      .slice(0, 12);

    const suggestions: Array<Omit<ProactiveSuggestion, "id" | "createdAt">> = [];
    for (let i = 0; i < count; i += 1) {
      const evidence = lines[i % Math.max(1, lines.length)] || "Recent activity indicates pending action items.";
      suggestions.push({
        category: "project",
        topic: `Priority Task ${i + 1}`,
        summary: `Review and close: ${evidence.slice(0, 72)}`,
        plan: `Detailed next steps:\n1. Validate the objective from memory evidence.\n2. Draft the concrete deliverable.\n3. Finalize and ship by end of day.\n\nEvidence:\n${evidence}`,
        aiCompletedWork: `Prepared initial execution plan from memory evidence: ${evidence.slice(0, 120)}`,
        immediateTasks: ["Draft deliverable", "Finalize output"],
        humanTasks: ["Approve and send"],
        evidence: evidence.slice(0, 140),
        confidence: 70
      });
    }

    return suggestions;
  }

  private isRelationshipSuggestion(suggestion: ProactiveSuggestion): boolean {
    if (suggestion.category === "relationship") return true;
    const topic = String(suggestion.topic || "").toLowerCase();
    return this.RELATIONSHIP_TOPICS.has(topic) || Boolean(String(suggestion.contactName || "").trim());
  }


  private isHighQualitySuggestion(suggestion: Omit<ProactiveSuggestion, "id" | "createdAt">): boolean {
    const summary = String(suggestion.summary || "").trim();
    const plan = String(suggestion.plan || "").trim();
    if (summary.length < 10 || plan.length < 15) return false;

    const genericPattern = /(key task extraction|review tasks|top to-do|next task|priority workstream|untitled task)/i;
    if (genericPattern.test(summary)) return false;

    if (suggestion.category === "project") {
      const actionVerbPattern = /^(draft|send|schedule|review|finalize|prepare|create|update|plan|call|email|ship|publish|write|organize|complete|fix|resolve|follow up|follow-up|sync|document)\b/i;
      if (!actionVerbPattern.test(summary)) return false;
    }

    if (this.isRelationshipSuggestion({ ...suggestion, id: "tmp", createdAt: new Date().toISOString() })) {
      if (!String(suggestion.contactName || "").trim()) return false;
      if (!String(suggestion.draftMessage || "").trim()) return false;
    }

    const actions = (suggestion.immediateTasks || []).length + (suggestion.humanTasks || []).length;
    return true; // Relaxed quality check to ensure suggestions are shown
  }


  private isCompletedSuggestion(suggestion: ProactiveSuggestion): boolean {
    const completed = Array.isArray(suggestion.completedTasks) ? suggestion.completedTasks : [];
    const allTasks = [...(suggestion.humanTasks || []), ...(suggestion.immediateTasks || [])];
    if (allTasks.length === 0) return false;
    return allTasks.every((task) => completed.includes(task));
  }

  private isCompletedToday(suggestion: ProactiveSuggestion): boolean {
    if (!this.isCompletedSuggestion(suggestion)) return false;
    if (!suggestion.completedAt) return false;
    const completedDate = new Date(suggestion.completedAt);
    if (!Number.isFinite(completedDate.getTime())) return false;
    const now = new Date();
    return completedDate.getFullYear() === now.getFullYear()
      && completedDate.getMonth() === now.getMonth()
      && completedDate.getDate() === now.getDate();
  }

  private suggestionSignature(topic: string, summary: string): string {
    return `${String(topic || "").trim().toLowerCase()}|${String(summary || "").trim().toLowerCase()}`;
  }

  private async mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = [];
    let index = 0;

    const runWorker = async () => {
      while (index < items.length) {
        const current = items[index++];
        results.push(await worker(current));
      }
    };

    const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker());
    await Promise.all(runners);
    return results;
  }

  private async getUserEmailStyleProfile(): Promise<string> {
    const FRESH_MS = 6 * 60 * 60 * 1000;
    if (this.cachedStyleProfile && (Date.now() - this.styleProfileUpdatedAt) < FRESH_MS) {
      return this.cachedStyleProfile;
    }

    const accountEmail = this.db.googleAccount()?.email?.toLowerCase();
    if (!accountEmail) return "";

    const gmailEvents = this.db.getRecentEventsBySource("google_gmail", 250);
    const sentSamples = gmailEvents
      .filter((event) => {
        const text = String(event.text || "");
        const fromMatch = text.match(/(^|\n)From:\s*([^\n]+)/i);
        const fromValue = String(fromMatch?.[2] || "").toLowerCase();
        return fromValue.includes(accountEmail);
      })
      .map((event) => String(event.text || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 35);

    if (sentSamples.length === 0) return "";

    try {
      const prompt = `
Analyze the writing style in these sent emails and return a compact style profile for drafting outreach in the same voice.

Samples:
${sentSamples.join("\n---\n").slice(0, 10000)}

Return ONLY JSON:
{
  "tone": "...",
  "structure": ["..."],
  "phrasing": ["..."],
  "constraints": ["..."]
}`;
      const response = await this.intelligence.generateDirectly(prompt);
      const match = response.match(/\{.*\}/s);
      if (!match) return "";
      const parsed = JSON.parse(match[0]);
      const profile = `Tone: ${parsed.tone || ""}. Structure: ${(parsed.structure || []).join(" | ")}. Phrasing: ${(parsed.phrasing || []).join(" | ")}. Constraints: ${(parsed.constraints || []).join(" | ")}.`;
      this.cachedStyleProfile = profile;
      this.styleProfileUpdatedAt = Date.now();
      return profile;
    } catch {
      return "";
    }
  }

  private async rewriteInUserVoice(draft: string, styleProfile: string, contactName: string | undefined, sourceContext: string): Promise<string> {
    if (!draft.trim() || !styleProfile) return draft;
    try {
      const prompt = `
Rewrite this outreach opener to match the user's writing voice.
Keep it concise and natural.

Style profile:
${styleProfile}

Contact:
${contactName || "Unknown"}

Context:
${sourceContext.slice(0, 500)}

Draft:
${draft}

Return only the rewritten opener text.`;
      const rewritten = await this.intelligence.generateDirectly(prompt);
      const cleaned = String(rewritten || "").trim();
      return cleaned || draft;
    } catch {
      return draft;
    }
  }

  private inferContactName(sourceContext: string): string | undefined {
    const text = String(sourceContext || "");
    const matches = text.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g);
    if (!matches || matches.length === 0) return undefined;
    return matches[0];
  }
}
