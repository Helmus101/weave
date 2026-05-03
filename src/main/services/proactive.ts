import { EventEmitter } from "node:events";
import { IntelligenceEngine } from "./intelligence";
import { RetrievalService } from "./retrieval";
import { WeaveDatabase } from "../db/client";
import type { ProactiveSuggestion, SourceReceipt } from "../../shared/types";

type SuggestionDraft = Omit<ProactiveSuggestion, "id" | "createdAt">;
type SignatureHistory = Record<string, string>;
type TopicRotation = Record<string, string>;
const SIGNATURE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TOPIC_ROTATION_RETENTION_MS = 36 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 250;

export class ProactiveService extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private cachedStyleProfile = "";
  private styleProfileUpdatedAt = 0;
  private generationInProgress = false;
  private readonly SIGNATURE_HISTORY_KEY = "proactive_signature_history";
  private readonly TOPIC_ROTATION_KEY = "proactive_topic_rotation_history";
  private readonly MAX_TOTAL = 6;
  private readonly MAX_RELATIONSHIP = 3;
  private readonly STALE_MS = 60 * 60 * 1000;

  constructor(
    private db: WeaveDatabase,
    private retrieval: RetrievalService,
    private intelligence: IntelligenceEngine
  ) {
    super();
  }

  start() {
    console.log("[Proactive] Starting background suggestion engine...");
    setTimeout(() => {
      if (this.areSuggestionsStale()) {
        void this.generateSuggestions();
      } else {
        console.log("[Proactive] Suggestions are fresh. Skipping startup generation.");
        this.emit("suggestions", this.getSuggestions());
      }
    }, 45_000);
    this.interval = setInterval(() => {
      if (this.areSuggestionsStale() && this.canSpendBackgroundBudget()) {
        void this.generateSuggestions();
      }
    }, 60 * 60 * 1000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  getSuggestions(): ProactiveSuggestion[] {
    try {
      return (this.db.kvGet<ProactiveSuggestion[]>("proactive_suggestions") || [])
        .slice(0, this.MAX_TOTAL)
        .map((suggestion) => this.normalizeSuggestion({
          ...suggestion,
          evidenceBundle: (suggestion.evidenceBundle || []).slice(0, 3).map((receipt) => ({
            ...receipt,
            snippet: String(receipt.snippet || "").slice(0, 220)
          }))
        }))
        .filter((suggestion) => !this.isDismissed(suggestion));
    } catch (error) {
      console.error("[Proactive] Failed reading cached suggestions. Resetting proactive cache:", error);
      this.db.kvSet("proactive_suggestions", [], "json");
      return [];
    }
  }

  async generateSuggestions(): Promise<ProactiveSuggestion[]> {
    if (this.generationInProgress) {
      console.log("[Proactive] Generation already in progress. Skipping overlap.");
      return this.getSuggestions();
    }
    if (!this.canSpendBackgroundBudget()) {
      console.log("[Proactive] Generation deferred because capture/indexing is under load.");
      return this.getSuggestions();
    }

    this.generationInProgress = true;
    this.emit("generationState", { inProgress: true });
    const startedAt = Date.now();

    try {
      const existing = this.getSuggestions();
      const handledKeys = new Set<string>([
        ...existing.filter((s) => s.state === "completed" || Boolean(s.convertedRoutineId)).map((s) => this.suggestionSignature(s.topic, s.summary)),
        ...existing.filter((s) => this.isCompletedToday(s)).map((s) => this.suggestionSignature(s.topic, s.summary)),
        ...this.getRecentSignatureHistory()
      ]);

      const active = existing.filter((s) => s.state === "active" && !this.isSnoozed(s));
      const carryForward = this.rankSuggestions(active)
        .filter((s) => !this.isCoolingDown(s))
        .slice(0, 3);

      const [relationshipContext, taskContext] = await Promise.all([
        this.buildMemoryContext("Relationship priorities, reconnection opportunities, initiative imbalances, and people who matter this week."),
        this.buildMemoryContext("Urgent tasks, unresolved loops, event preparation, and short high-leverage actions I should take next.")
      ]);

      const candidateCount = 5;
      const [relationshipDrafts, taskDrafts] = await Promise.all([
        this.generateRelationshipSuggestions(relationshipContext, candidateCount, handledKeys),
        this.generateTaskSuggestions(taskContext, candidateCount, handledKeys)
      ]);

      const stampDraft = (suggestion: SuggestionDraft): ProactiveSuggestion => ({
        id: Math.random().toString(36).slice(2),
        createdAt: new Date().toISOString(),
        ...suggestion
      });

      const candidates = [...carryForward, ...relationshipDrafts.map(stampDraft), ...taskDrafts.map(stampDraft)]
        .map((suggestion) => this.normalizeSuggestion(suggestion))
        .filter((suggestion, index, arr) => {
          const signature = this.suggestionSignature(suggestion.topic, suggestion.summary);
          return arr.findIndex((item) => this.suggestionSignature(item.topic, item.summary) === signature) === index;
        })
        .filter((suggestion) => !this.isDismissed(suggestion) && !this.isSnoozed(suggestion))
        .filter((suggestion) => !this.isTopicRecentlySurfaced(suggestion))
        .filter((suggestion) => !handledKeys.has(this.suggestionSignature(suggestion.topic, suggestion.summary)));

      const ranked = this.rankSuggestions(candidates);
      const selected = this.selectDashboardSuggestions(ranked);

      this.recordSignatureHistory(selected);
      this.recordTopicRotation(selected);
      this.db.kvSet("proactive_suggestions", selected.map((suggestion) => ({
        ...suggestion,
        evidenceBundle: (suggestion.evidenceBundle || []).slice(0, 3).map((receipt) => ({
          ...receipt,
          snippet: String(receipt.snippet || "").slice(0, 220)
        }))
      })), "json");
      this.db.setSubsystemHealth("capture", {
        lastProactiveDurationMs: Date.now() - startedAt
      });
      this.emit("suggestions", selected);
      console.log(`[Proactive] Done. Selected ${selected.length} ranked suggestions.`);
      return selected;
    } catch (e) {
      console.error("[Proactive] Generation failed:", e);
      return this.getSuggestions();
    } finally {
      this.generationInProgress = false;
      this.emit("generationState", { inProgress: false });
    }
  }

  async getTaskDetail(summary: string, plan?: string, evidence?: string): Promise<string> {
    const context = await this.buildMemoryContext(`Steps to accomplish: ${summary}`);

    const prompt = `You are Weave, the user's chief-of-staff assistant.

Task: ${summary}
${plan ? `Context: ${plan}` : ""}
${evidence ? `Evidence: ${evidence}` : ""}

Memory context:
${context.slice(0, 4000)}

Produce the most useful work product you can right now.

1. If writing or planning would help, generate the draft or structured plan directly.
2. End with a section titled **What you still need to do:** listing 1-3 concrete real-world actions the user must take.
3. Be concise, executive, and operational. No preamble.`;

    try {
      return await this.intelligence.generateDirectly(prompt);
    } catch (e) {
      console.error("[Proactive] getTaskDetail failed:", e);
      return "I could not generate a full workup, but the next best move is to use the evidence and next action above as your operating brief.";
    }
  }

  private areSuggestionsStale(): boolean {
    const existing = this.getSuggestions().filter((s) => s.state === "active");
    if (existing.length === 0) return true;
    const latestTs = existing.reduce((max, s) => {
      const t = new Date(s.createdAt).getTime();
      return t > max ? t : max;
    }, 0);
    return !Number.isFinite(latestTs) || (Date.now() - latestTs) > this.STALE_MS;
  }

  private selectDashboardSuggestions(suggestions: ProactiveSuggestion[]) {
    const selected: ProactiveSuggestion[] = [];
    let relationshipCount = 0;

    for (const suggestion of suggestions) {
      if (selected.length >= this.MAX_TOTAL) break;
      if (suggestion.category === "relationship" && relationshipCount >= this.MAX_RELATIONSHIP) {
        continue;
      }
      selected.push(suggestion);
      if (suggestion.category === "relationship") relationshipCount += 1;
    }

    return selected.map((suggestion) => this.normalizeSuggestion(suggestion));
  }

  private rankSuggestions(suggestions: ProactiveSuggestion[]) {
    return [...suggestions]
      .map((suggestion) => this.normalizeSuggestion(suggestion))
      .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
  }

  private normalizeSuggestion(suggestion: ProactiveSuggestion): ProactiveSuggestion {
    const evidenceDensity = Math.min(1, ((suggestion.evidenceBundle?.length || 0) + (suggestion.evidence ? 1 : 0)) / 3);
    const confidence = Math.max(0, Math.min(100, suggestion.confidence || 75));
    const urgency = this.computeUrgencyScore(suggestion);
    const novelty = this.computeNoveltyScore(suggestion);
    const impact = this.computeImpactScore(suggestion);
    const freshnessScore = this.computeFreshnessScore(suggestion);
    const priorityScore = Math.round(
      confidence * 0.28
      + urgency * 0.32
      + novelty * 0.16
      + impact * 0.16
      + evidenceDensity * 100 * 0.08
    );
    const nextAction = suggestion.nextAction
      || suggestion.impliedAction
      || suggestion.immediateTasks?.[0]
      || suggestion.humanTasks?.[0]
      || undefined;
    const lane = suggestion.lane || (priorityScore >= 73 ? "do_now" : "keep_warm");
    const sourceMix = suggestion.sourceMix?.length
      ? suggestion.sourceMix
      : this.inferSourceMix(suggestion);

    return {
      ...suggestion,
      state: suggestion.state || (suggestion.completedAt ? "completed" : "active"),
      nextAction,
      freshnessScore,
      priorityScore,
      sourceMix,
      lane,
      reasonIncluded: suggestion.reasonIncluded || this.buildReasonIncluded(suggestion, priorityScore, freshnessScore),
      noveltyKey: suggestion.noveltyKey || this.suggestionSignature(suggestion.topic, suggestion.summary),
      supportingNodeIds: suggestion.supportingNodeIds || [],
      supportingEventIds: suggestion.supportingEventIds || []
    };
  }

  private computeUrgencyScore(suggestion: ProactiveSuggestion) {
    let score = 45;
    const text = `${suggestion.whyNow || ""} ${suggestion.plan || ""} ${suggestion.evidence || ""}`.toLowerCase();
    if (/today|tomorrow|this afternoon|this morning|tonight|upcoming|before|deadline|meeting|calendar|scheduled/.test(text)) score += 20;
    if (/waiting|blocked|stalled|overdue|carry-over|carried over|follow-up pending|unanswered/.test(text)) score += 12;
    if (typeof suggestion.daysSinceLastContact === "number") {
      score += Math.min(20, Math.max(0, suggestion.daysSinceLastContact / 3));
    }
    if (suggestion.suggestionClass === "event_prep") score += 18;
    if (suggestion.suggestionClass === "unresolved_loop") score += 14;
    return Math.min(100, score);
  }

  private computeImpactScore(suggestion: ProactiveSuggestion) {
    let score = 55;
    if (suggestion.category === "relationship") score += 10;
    if (suggestion.suggestionClass === "momentum_opportunity") score += 10;
    if (suggestion.suggestionClass === "relationship_nudge") score += 6;
    if ((suggestion.plan || "").split(".").length > 2) score += 6;
    if ((suggestion.evidenceBundle?.length || 0) >= 2) score += 8;
    return Math.min(100, score);
  }

  private computeFreshnessScore(suggestion: ProactiveSuggestion) {
    const createdAt = new Date(suggestion.createdAt || Date.now()).getTime();
    if (!Number.isFinite(createdAt)) return 50;
    const elapsedHours = (Date.now() - createdAt) / (60 * 60 * 1000);
    return Math.max(20, Math.min(100, 100 - elapsedHours * 8));
  }

  private computeNoveltyScore(suggestion: ProactiveSuggestion) {
    let score = 72;
    if (this.getRecentSignatureHistory().includes(this.suggestionSignature(suggestion.topic, suggestion.summary))) score -= 28;
    if (this.isTopicRecentlySurfaced(suggestion)) score -= 18;
    if (suggestion.convertedRoutineId) score -= 40;
    return Math.max(10, Math.min(100, score));
  }

  private inferSourceMix(suggestion: ProactiveSuggestion): Array<"memory" | "web" | "calendar" | "contacts"> {
    const mix = new Set<"memory" | "web" | "calendar" | "contacts">(["memory"]);
    if (suggestion.category === "relationship") mix.add("contacts");
    if (/calendar|meeting|scheduled/.test(`${suggestion.whyNow || ""} ${suggestion.plan || ""}`.toLowerCase())) mix.add("calendar");
    return [...mix];
  }

  private buildReasonIncluded(suggestion: ProactiveSuggestion, priorityScore: number, freshnessScore: number) {
    const reasons: string[] = [];
    if (priorityScore >= 78) reasons.push("high leverage");
    if (freshnessScore >= 70) reasons.push("fresh context");
    if (suggestion.suggestionClass === "event_prep") reasons.push("time-bound");
    if (suggestion.category === "relationship") reasons.push("relationship signal");
    if ((suggestion.evidenceBundle?.length || 0) > 1) reasons.push("multi-source evidence");
    return reasons.length > 0
      ? `Surfaced because this looks ${reasons.join(", ")}.`
      : "Surfaced because recent memory signals point to a concrete next move.";
  }

  private async generateRelationshipSuggestions(
    context: string,
    count: number,
    existingKeys: Set<string>
  ): Promise<SuggestionDraft[]> {
    if (!context.trim()) return [];

    const styleProfile = await this.getUserEmailStyleProfile();
    const prompt = `You are the user's chief-of-staff for relationships.

Memory Context:
${context.slice(0, 12000)}

Generate up to ${count} relationship actions that are worth surfacing now.

Requirements:
- Only use people actually present in memory.
- Each suggestion must feel executive and specific.
- State the exact signal behind the suggestion.
- Give one low-friction next move.
- Avoid generic phrases like "follow up" without object or context.
- Prefer neglected, time-sensitive, asymmetric, or opportunistic relationships.

Return ONLY valid JSON array:
[
  {
    "category": "relationship",
    "insightCategory": "health" | "initiative" | "opportunity" | "neglected" | "asymmetry",
    "contactName": "First name only",
    "topic": "Short label",
    "summary": "Specific, human-readable action framing",
    "interpretation": "Two grounded sentences explaining the signal",
    "whyNow": "One sentence about why this matters now",
    "impliedAction": "One clear next move under 5 minutes",
    "draftMessage": "2-3 sentence natural opener",
    "plan": "Evidence-backed relationship briefing",
    "daysSinceLastContact": 12,
    "evidence": "Specific observed memory anchor with time if available",
    "confidence": 80,
    "nextAction": "Single next move",
    "immediateTasks": ["Single next action"]
  }
]`;

    try {
      const response = await this.intelligence.generateDirectly(prompt);
      const match = response.match(/\[.*\]/s);
      if (!match) return [];
      const parsed: any[] = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      const results: SuggestionDraft[] = [];
      for (const item of parsed.slice(0, count)) {
        const contactName = String(item.contactName || "").trim();
        const topic = String(item.topic || "Relationship").trim();
        const summary = String(item.summary || "").trim();
        if (!contactName || !summary) continue;
        if (existingKeys.has(this.suggestionSignature(topic, summary))) continue;

        const rawDraft = String(item.draftMessage || "").trim();
        const draftMessage =
          rawDraft && styleProfile
            ? await this.rewriteInUserVoice(rawDraft, styleProfile, contactName, String(item.plan || ""))
            : rawDraft;

        const evidenceSnippet = String(item.evidence || item.plan || "").replace(/\s+/g, " ").slice(0, 220);
        results.push({
          category: "relationship",
          suggestionClass: "relationship_nudge",
          insightCategory: item.insightCategory || "health",
          contactName,
          topic,
          summary,
          interpretation: String(item.interpretation || "").trim() || undefined,
          whyNow: String(item.whyNow || "").trim() || undefined,
          impliedAction: String(item.impliedAction || "").trim() || undefined,
          draftMessage: draftMessage || undefined,
          plan: String(item.plan || "").trim(),
          daysSinceLastContact: Number.isFinite(Number(item.daysSinceLastContact))
            ? Number(item.daysSinceLastContact)
            : undefined,
          evidence: String(item.evidence || "").slice(0, 180),
          evidenceBundle: [{
            id: `relationship-${contactName}-${topic}`,
            kind: "memory",
            title: `${contactName} relationship context`,
            snippet: evidenceSnippet,
            reason: "Relationship memory evidence"
          }],
          confidence: Number(item.confidence) || 78,
          nextAction: String(item.nextAction || item.impliedAction || item.immediateTasks?.[0] || "").trim() || undefined,
          immediateTasks: Array.isArray(item.immediateTasks) ? item.immediateTasks.slice(0, 1).map(String) : [],
          humanTasks: [],
          noveltyKey: this.suggestionSignature(topic, summary),
          sourceMix: ["memory", "contacts"],
          reasonIncluded: "Surfaced from relationship recency, initiative, or opportunity signals.",
          supportingNodeIds: [],
          supportingEventIds: [],
          state: "active"
        });
      }
      return results;
    } catch (e) {
      console.error("[Proactive] Relationship generation failed:", e);
      return [];
    }
  }

  private async generateTaskSuggestions(
    context: string,
    count: number,
    existingKeys: Set<string>
  ): Promise<SuggestionDraft[]> {
    if (!context.trim()) return [];

    const prompt = `You are the user's chief-of-staff assistant.

Memory Context:
${context.slice(0, 12000)}

Generate up to ${count} professional proactive suggestions.

Requirements:
- Focus on the best immediate actions, not generic goals.
- Each suggestion must be grounded in a concrete signal from memory.
- Summary must start with a strong action verb and specific object.
- "Why now" must reference timing, momentum, deadline, meeting, or unresolved context.
- Include exactly one next move.
- Spread suggestions across:
  - momentum_opportunity
  - unresolved_loop
  - event_prep
  - habit_deviation
  - latent_follow_up

Return ONLY valid JSON array:
[
  {
    "category": "project",
    "suggestionClass": "momentum_opportunity" | "unresolved_loop" | "event_prep" | "habit_deviation" | "latent_follow_up",
    "topic": "2-3 word task area",
    "summary": "Action verb + specific deliverable",
    "whyNow": "One grounded sentence explaining timing or leverage",
    "plan": "2-3 sentences with evidence and next move",
    "evidence": "Specific memory anchor with time if available",
    "confidence": 85,
    "nextAction": "Single next move",
    "immediateTasks": ["Single next action"]
  }
]`;

    try {
      const response = await this.intelligence.generateDirectly(prompt);
      const match = response.match(/\[.*\]/s);
      if (!match) return [];
      const parsed: any[] = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      const results: SuggestionDraft[] = [];
      for (const item of parsed.slice(0, count)) {
        const topic = String(item.topic || "Task").trim();
        const summary = String(item.summary || "").trim();
        if (!summary) continue;
        if (existingKeys.has(this.suggestionSignature(topic, summary))) continue;

        const evidenceSnippet = String(item.evidence || item.plan || "").replace(/\s+/g, " ").slice(0, 220);
        results.push({
          category: "project",
          suggestionClass: item.suggestionClass || "momentum_opportunity",
          topic,
          summary,
          whyNow: String(item.whyNow || "").trim() || undefined,
          plan: String(item.plan || "").trim(),
          evidence: String(item.evidence || "").slice(0, 180),
          evidenceBundle: [{
            id: `suggestion-${topic}-${summary}`,
            kind: "memory",
            title: summary,
            snippet: evidenceSnippet,
            reason: "Memory context supporting this proactive suggestion"
          }],
          confidence: Number(item.confidence) || 80,
          nextAction: String(item.nextAction || item.immediateTasks?.[0] || "").trim() || undefined,
          immediateTasks: Array.isArray(item.immediateTasks) ? item.immediateTasks.slice(0, 1).map(String) : [],
          humanTasks: [],
          noveltyKey: this.suggestionSignature(topic, summary),
          sourceMix: ["memory"],
          reasonIncluded: "Surfaced from recent work context and timing signals.",
          supportingNodeIds: [],
          supportingEventIds: [],
          state: "active"
        });
      }
      return results;
    } catch (e) {
      console.error("[Proactive] Task generation failed:", e);
      return [];
    }
  }

  private async buildMemoryContext(query: string): Promise<string> {
    const sections: string[] = [];
    try {
      const { results, filters } = await this.retrieval.searchWithTrace(query, 20, { layers: ["RAW", "EPISODE", "INSIGHT", "SEMANTIC"] });
      if (results.length > 0) {
        sections.push(`RANKED MEMORY:\n${results.map((r) => `${r.title}: ${r.snippet}`).join("\n")}`);
      }
      const recent = await this.retrieval.getRecentContext(filters);
      if (recent.trim()) {
        sections.push(`RECENT TIMELINE:\n${recent}`);
      }
      const keywords = query.toLowerCase().match(/[a-z0-9]{4,}/g)?.slice(0, 8) || [];
      const matchedEvents = this.db.searchEventsByKeywords(keywords, 25);
      if (matchedEvents.length > 0) {
        sections.push(`MATCHED RAW EVENTS:\n${matchedEvents.map((event) => `[${event.source}][${event.timestamp}] ${String(event.text || "").replace(/\s+/g, " ").slice(0, 220)}`).join("\n")}`);
      }
    } catch (e) {
      console.warn("[Proactive] Retrieval failed:", e);
    }

    const recentRaw = this.db.getRecentEvents(80)
      .map((e) => `${e.type}@${e.timestamp}: ${String(e.text || "").replace(/\s+/g, " ").slice(0, 220)}`)
      .filter(Boolean)
      .slice(0, 20)
      .join("\n");
    if (recentRaw) sections.push(`RECENT RAW EVENTS:\n${recentRaw}`);

    const upcomingCalendar = this.db.getRecentEventsBySource("google_calendar", 12)
      .slice(0, 5)
      .map((event) => `[${event.timestamp}] ${String(event.text || "").replace(/\s+/g, " ").slice(0, 180)}`)
      .join("\n");
    if (upcomingCalendar) sections.push(`CALENDAR SIGNALS:\n${upcomingCalendar}`);

    const recentEmailSignals = this.db.getRecentEventsBySource("google_gmail", 12)
      .slice(0, 6)
      .map((event) => `[${event.timestamp}] ${String(event.text || "").replace(/\s+/g, " ").slice(0, 180)}`)
      .join("\n");
    if (recentEmailSignals) sections.push(`EMAIL SIGNALS:\n${recentEmailSignals}`);

    return sections.filter(Boolean).join("\n\n") || "No context available.";
  }

  private async getUserEmailStyleProfile(): Promise<string> {
    const freshMs = 6 * 60 * 60 * 1000;
    if (this.cachedStyleProfile && Date.now() - this.styleProfileUpdatedAt < freshMs) {
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
      const prompt = `Analyze the writing style in these sent emails and return a compact style profile for drafting outreach in the same voice.

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

  private async rewriteInUserVoice(
    draft: string,
    styleProfile: string,
    contactName: string | undefined,
    sourceContext: string
  ) {
    if (!draft.trim() || !styleProfile) return draft;
    try {
      const prompt = `Rewrite this outreach opener to match the user's writing voice. Keep it concise, natural, and warm.

Style profile:
${styleProfile}

Contact: ${contactName || "Unknown"}
Context: ${sourceContext.slice(0, 500)}

Draft:
${draft}

Return only the rewritten opener text.`;
      const rewritten = await this.intelligence.generateDirectly(prompt);
      return String(rewritten || "").trim() || draft;
    } catch {
      return draft;
    }
  }

  private suggestionSignature(topic: string, summary: string) {
    return `${String(topic || "").trim().toLowerCase()}|${String(summary || "").trim().toLowerCase()}`;
  }

  private recordSignatureHistory(suggestions: ProactiveSuggestion[]) {
    const current = this.pruneHistory(this.db.kvGet<SignatureHistory>(this.SIGNATURE_HISTORY_KEY) || {}, SIGNATURE_RETENTION_MS);
    const now = new Date().toISOString();
    for (const suggestion of suggestions) {
      current[this.suggestionSignature(suggestion.topic, suggestion.summary)] = now;
    }
    this.db.kvSet(this.SIGNATURE_HISTORY_KEY, this.limitHistory(current), "json");
  }

  private getRecentSignatureHistory() {
    const current = this.pruneHistory(this.db.kvGet<SignatureHistory>(this.SIGNATURE_HISTORY_KEY) || {}, SIGNATURE_RETENTION_MS);
    const cutoff = Date.now() - SIGNATURE_RETENTION_MS;
    return Object.entries(current)
      .filter(([, timestamp]) => new Date(timestamp).getTime() >= cutoff)
      .map(([signature]) => signature);
  }

  private recordTopicRotation(suggestions: ProactiveSuggestion[]) {
    const current = this.pruneHistory(this.db.kvGet<TopicRotation>(this.TOPIC_ROTATION_KEY) || {}, TOPIC_ROTATION_RETENTION_MS);
    const now = new Date().toISOString();
    for (const suggestion of suggestions) {
      const key = this.topicRotationKey(suggestion);
      current[key] = now;
    }
    this.db.kvSet(this.TOPIC_ROTATION_KEY, this.limitHistory(current), "json");
  }

  private isTopicRecentlySurfaced(suggestion: ProactiveSuggestion) {
    const current = this.pruneHistory(this.db.kvGet<TopicRotation>(this.TOPIC_ROTATION_KEY) || {}, TOPIC_ROTATION_RETENTION_MS);
    const stamp = current[this.topicRotationKey(suggestion)];
    if (!stamp) return false;
    const age = Date.now() - new Date(stamp).getTime();
    return Number.isFinite(age) && age < TOPIC_ROTATION_RETENTION_MS;
  }

  private topicRotationKey(suggestion: ProactiveSuggestion) {
    return [
      suggestion.category || "project",
      suggestion.suggestionClass || "general",
      (suggestion.contactName || suggestion.topic || "").trim().toLowerCase()
    ].join("|");
  }

  private isCoolingDown(suggestion: ProactiveSuggestion) {
    if (!suggestion.createdAt) return false;
    const age = Date.now() - new Date(suggestion.createdAt).getTime();
    if (!Number.isFinite(age)) return false;
    if (suggestion.state !== "active") return true;
    const cooldownMs = suggestion.lane === "do_now" ? 90 * 60 * 1000 : 6 * 60 * 60 * 1000;
    return age < cooldownMs;
  }

  private isCompletedSuggestion(suggestion: ProactiveSuggestion) {
    if (suggestion.state === "completed" || suggestion.completedAt || suggestion.convertedRoutineId) return true;
    const completed = Array.isArray(suggestion.completedTasks) ? suggestion.completedTasks : [];
    const allTasks = [...(suggestion.humanTasks || []), ...(suggestion.immediateTasks || [])];
    return allTasks.length > 0 && allTasks.every((task) => completed.includes(task));
  }

  private isCompletedToday(suggestion: ProactiveSuggestion) {
    if (!this.isCompletedSuggestion(suggestion) || !suggestion.completedAt) return false;
    const completed = new Date(suggestion.completedAt);
    if (!Number.isFinite(completed.getTime())) return false;
    const now = new Date();
    return completed.getFullYear() === now.getFullYear()
      && completed.getMonth() === now.getMonth()
      && completed.getDate() === now.getDate();
  }

  private isDismissed(suggestion: ProactiveSuggestion) {
    return suggestion.state === "dismissed" || Boolean(suggestion.dismissedAt);
  }

  private isSnoozed(suggestion: ProactiveSuggestion) {
    return Boolean(suggestion.snoozedUntil) && new Date(String(suggestion.snoozedUntil)).getTime() > Date.now();
  }

  private canSpendBackgroundBudget() {
    const captureHealth = this.db.getSubsystemHealth().capture || {};
    const queueDepth = Number(captureHealth.queueDepth || 0);
    const captureLagMs = Number(captureHealth.captureLagMs || 0);
    return queueDepth < 4 && captureLagMs < 90_000;
  }

  private pruneHistory<T extends Record<string, string>>(history: T, retentionMs: number): T {
    const cutoff = Date.now() - retentionMs;
    return Object.fromEntries(
      Object.entries(history).filter(([, timestamp]) => new Date(timestamp).getTime() >= cutoff)
    ) as T;
  }

  private limitHistory<T extends Record<string, string>>(history: T): T {
    return Object.fromEntries(
      Object.entries(history)
        .sort((left, right) => new Date(right[1]).getTime() - new Date(left[1]).getTime())
        .slice(0, MAX_HISTORY_ENTRIES)
    ) as T;
  }
}
