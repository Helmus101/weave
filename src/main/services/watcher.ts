import { EventEmitter } from "node:events";
import type { CaptureState, MemoryLayer } from "../../shared/types";
import type { WeaveDatabase } from "../db/client";
import { extractEntities, extractIntents, summarizeLocally } from "./extraction";
import { isBlacklisted } from "./blacklist";
import type { OcrBridge, OcrCaptureResult } from "./ocrBridge";
import type { VectorStore } from "./vectorStore";
import type { DeepSeekService } from "./deepseek";

export class WatcherService extends EventEmitter {
  private readonly FULL_OCR_INTERVAL_MS = 2 * 60 * 1000;
  private timer?: NodeJS.Timeout;
  private proactiveTimer?: NodeJS.Timeout;
  private state: CaptureState;
  private systemPaused = false;
  private lastSynthesisAt = 0; // epoch ms — cooldown guard
  private stopped = false;
  private lifecycleGeneration = 0;
  private captureInFlight = false;
  private synthesisInFlight = false;
  private historicalSynthesisInFlight = false;
  private proactivePulseInFlight = false;
  private skippedTicks = 0;
  private deferredSynthesisCount = 0;
  private indexInFlight = false;
  private indexQueue: Array<{ nodeId: string; timestamp: string; app?: string; windowTitle?: string; text: string; result: OcrCaptureResult; generation: number }> = [];
  private synthesisQueue: Array<{ nodeId: string; appName: string; rawText: string; force: boolean; generation: number }> = [];
  private lastOcrSignature?: string;
  private lastOcrSampleAt = 0;

  constructor(
    private db: WeaveDatabase,
    private vectors: VectorStore,
    private ocr: OcrBridge,
    private deepseek: DeepSeekService,
    private captureEnabledProvider: () => boolean,
    private captureEnabledSetter: (enabled: boolean) => void,
    private blacklistProvider: () => { apps: string[], websites: string[] }
  ) {

    super();
    this.state = {
      status: captureEnabledProvider() ? "running" : "paused",
      enabled: captureEnabledProvider(),
      screenPermission: "unknown"
    };
    
    // Proactive Search Daemon (Stage 6)
    // Run every 6 hours
    this.proactiveTimer = setInterval(() => {
      void this.runProactiveSearch();
    }, 6 * 60 * 60 * 1000);
  }

  setSystemPaused(paused: boolean) {
    this.systemPaused = paused;
    console.log(`[Watcher] System power state changed: ${paused ? "Paused (Sleep/Lock)" : "Resumed"}`);
    if (!paused && this.captureEnabledProvider()) {
      void this.captureTick(false, this.lifecycleGeneration);
    }
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.lifecycleGeneration += 1;
    const generation = this.lifecycleGeneration;
    this.timer = setInterval(() => {
      void this.captureTick(false, generation);
    }, 30_000);
    if (this.captureEnabledProvider()) void this.captureTick(false, generation);
    
    // Run proactive search on startup too
    void this.runProactiveSearch();
  }

  stop() {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    this.timer = undefined;
    this.proactiveTimer = undefined;
    this.update({ status: "idle" });
  }

  getState() {
    this.refreshCadenceStatus();
    return this.state;
  }

  canRunBackgroundWork() {
    const lag = this.computeCaptureLagMs() ?? 0;
    return !this.captureInFlight && this.computeQueueDepth() < 6 && lag < 90_000;
  }

  setEnabled(enabled: boolean) {
    this.captureEnabledSetter(enabled);
    this.update({ enabled, status: enabled ? "running" : "paused" });
    if (enabled) void this.captureTick(false, this.lifecycleGeneration);
    return this.state;
  }

  async synthesizeNow() {
    console.log("[Director] Manual synthesis triggered...");
    await this.synthesizeDetailedMemory("manual", "manual", "manual", true);
  }

  async runNow() {
    await this.captureTick(true, this.lifecycleGeneration);
    return this.state;
  }

  recordProbeResult(result: OcrCaptureResult) {
    this.applyOcrState(result);

    if (result.ok) {
      this.update({ lastCaptureAt: result.timestamp, lastOcrAt: result.timestamp, cadenceStatus: "healthy" });
      this.db.setSubsystemHealth("capture", {
        lastSuccessAt: result.timestamp,
        lastOcrAt: result.timestamp,
        lastFailureAt: undefined,
        lastFailureMessage: undefined,
        cadenceStatus: "healthy",
        queueDepth: this.computeQueueDepth(),
        indexQueueDepth: this.indexQueue.length + Number(this.indexInFlight),
        synthesisQueueDepth: this.synthesisQueue.length + Number(this.synthesisInFlight),
        skippedTicks: this.skippedTicks,
        captureLagMs: this.computeCaptureLagMs()
      });
      return;
    }

    this.db.setSubsystemHealth("capture", {
      lastFailureAt: new Date().toISOString(),
      lastFailureMessage: result.error || "OCR capture failed"
    });
    this.refreshCadenceStatus();
  }

  async synthesizeHistoricalBatch(nodes: any[]) {
    if (this.historicalSynthesisInFlight) {
      console.log("[Director] Historical synthesis already running. Skipping overlap.");
      return;
    }
    this.historicalSynthesisInFlight = true;
    console.log(`[Director] Starting historical batch synthesis for ${nodes.length} nodes...`);
    try {
      // Group by YYYY-MM
      const grouped = new Map<string, any[]>();
      for (const node of nodes) {
        const dateStr = node.anchorAt || node.createdAt || new Date().toISOString();
        const monthKey = dateStr.slice(0, 7); // YYYY-MM
        if (!grouped.has(monthKey)) grouped.set(monthKey, []);
        grouped.get(monthKey)!.push(node);
      }

      // Process each month
      for (const [month, monthNodes] of grouped.entries()) {
        console.log(`[Director] Synthesizing historical episode for ${month} (${monthNodes.length} items)...`);
        
        // Sort chronologically and take up to 200 items to avoid blowing up context
        monthNodes.sort((a, b) => new Date(a.anchorAt).getTime() - new Date(b.anchorAt).getTime());
        const sampledNodes = monthNodes.slice(0, 200);
        
        const bullets = sampledNodes.map(n => `- [${n.anchorAt.slice(8, 10)}] ${n.title}: ${n.summary.slice(0, 100)}`);
        const fullLog = bullets.join("\n").slice(0, 10000); // hard cap at ~10k chars

        const prompt = `
You are the "Director of Human Memory". Summarize this historical data archive for the month of ${month}.
This data contains calendar events and emails.

Raw Event Log:
${fullLog}

Return ONLY a JSON object:
{
  "title": "Historical Archive: ${month}",
  "narrative": "A 2-4 sentence summary of the key themes, people, and topics from this month.",
  "raw_summary_bullets": ["3-5 high-level bullet points summarizing the month"],
  "behavioral": { "focus_score": 5, "vibe": "Archive", "app_signature": "Google Workspace" },
  "entities": {
    "people": ["Name"],
    "technical_topics": ["Topic"],
    "status": "Archived",
    "context": "Historical Sync"
  },
  "primary_project": "Historical Archive"
}`;

        try {
          const response = this.deepseek.hasApiKey() ? await this.deepseek.reason(prompt) : "";
          const jsonMatch = response.match(/\{.*\}/s);
          const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
          
          if (parsed) {
            const data = this.normalizeEpisodeData(parsed, parsed, "Google Workspace", parsed.raw_summary_bullets, sampledNodes, month);
            const episodeId = this.persistEpisode(data, sampledNodes);
            await this.vectors.upsertInteraction(episodeId, `${data.narrative}\n${data.raw_summary_bullets.join("\n")}`, `${month}-01T00:00:00Z`, {
              app: "Historical Sync",
              windowTitle: `Archive ${month}`
            });
          }
        } catch (e) {
          console.error(`[Director] Failed historical synthesis for ${month}:`, e);
        }
        await this.yieldToEventLoop();
      }
    } finally {
      this.historicalSynthesisInFlight = false;
    }
  }

  private async captureTick(force = false, generation = this.lifecycleGeneration) {
    if (this.captureInFlight && !force) {
      this.skippedTicks += 1;
      this.refreshCadenceStatus();
      return;
    }
    const captureStartedAt = Date.now();
    this.captureInFlight = true;
    try {
      if (!this.captureEnabledProvider() || this.systemPaused) {
        this.update({ 
          enabled: this.captureEnabledProvider(), 
          status: this.systemPaused ? "idle" : "paused",
          cadenceStatus: "paused"
        });
        return;
      }

      if (!this.isActiveGeneration(generation)) return;
      this.update({ enabled: true, status: "running" });
      const shouldRunFullCapture = force || await this.shouldRunFullCapture();
      const ocrStartedAt = Date.now();
      const result = shouldRunFullCapture ? await this.ocr.capture() : await this.ocr.status();
      const ocrDurationMs = Date.now() - ocrStartedAt;
      if (!this.isActiveGeneration(generation)) return;

      this.recordProbeResult(result);
      this.update({
        ocrDurationMs,
        captureDurationMs: Date.now() - captureStartedAt
      });
      this.db.setSubsystemHealth("capture", {
        ocrDurationMs,
        captureDurationMs: Date.now() - captureStartedAt,
        queueDepth: this.computeQueueDepth(),
        indexQueueDepth: this.indexQueue.length + Number(this.indexInFlight),
        synthesisQueueDepth: this.synthesisQueue.length + Number(this.synthesisInFlight)
      });

      if (!result.ok) return;
      if (!shouldRunFullCapture) {
        this.update({ lastCaptureAt: result.timestamp, cadenceStatus: "healthy" });
        return;
      }
      if (!result.text.trim()) return;
      const blacklist = this.blacklistProvider();
      if (isBlacklisted(
        { appName: result.activeApp, bundleId: result.activeBundleId, title: result.activeWindowTitle },
        blacklist.apps,
        blacklist.websites
      )) {
        this.update({ status: "blocked" });
        return;
      }

      if (!this.isActiveGeneration(generation)) return;

      // 1. Store as Raw Event
      const summary = summarizeLocally(result.text);
      const nodeId = this.db.writeBatch(() => {
        const eventId = this.db.addEvent({
          type: "ocr",
          timestamp: result.timestamp,
          source: result.activeApp ?? "unknown",
          text: result.text,
          metadata: {
            bundleId: result.activeBundleId,
            windowTitle: result.activeWindowTitle,
            ocrBlocks: result.blocks
          }
        });

        return this.db.addMemoryNode({
          layer: "RAW",
          subtype: "screen_capture",
          title: result.activeWindowTitle || result.activeApp || "Screen Capture",
          summary,
          canonicalText: result.text,
          sourceRefs: [eventId],
          metadata: {
            app: result.activeApp,
            bundleId: result.activeBundleId,
            windowTitle: result.activeWindowTitle,
            ocrBlocks: result.blocks
          },
          anchorAt: result.timestamp
        });
      });
      this.update({ lastIndexedAt: result.timestamp, lastIndexedNodeId: nodeId, cadenceStatus: "healthy" });
      this.db.setSubsystemHealth("capture", {
        lastIndexedAt: result.timestamp,
        cadenceStatus: "healthy",
        queueDepth: this.computeQueueDepth(),
        indexQueueDepth: this.indexQueue.length + Number(this.indexInFlight),
        synthesisQueueDepth: this.synthesisQueue.length + Number(this.synthesisInFlight),
        skippedTicks: this.skippedTicks,
        captureLagMs: this.computeCaptureLagMs(),
        retrievalCoverage: "raw node persisted"
      });
      this.lastOcrSignature = this.makeCaptureSignature(result);
      this.lastOcrSampleAt = Date.now();
      this.enqueueIndexWork({ nodeId, timestamp: result.timestamp, app: result.activeApp, windowTitle: result.activeWindowTitle, text: result.text, result, generation });
      this.enqueueSynthesisWork({ nodeId, appName: result.activeApp || "unknown", rawText: result.text, force, generation });
    } catch (error: any) {
      if (!this.isActiveGeneration(generation) || this.isDatabaseClosedError(error)) {
        return;
      }
      console.error("[Watcher] Capture tick failed:", error);
      this.db.setSubsystemHealth("capture", {
        lastFailureAt: new Date().toISOString(),
        lastFailureMessage: error?.message || "Capture tick failed"
      });
      this.update({ status: "error", lastError: error?.message || "Capture tick failed" });
    } finally {
      this.captureInFlight = false;
    }
  }

  private async synthesizeDetailedMemory(nodeId: string, appName: string, rawText: string, force = false, generation = this.lifecycleGeneration) {
    if (this.synthesisInFlight && !force) {
      this.deferredSynthesisCount += 1;
      this.refreshCadenceStatus();
      return;
    }
    try {
      const now = Date.now();
      const COOLDOWN_MS = 60 * 60 * 1000; // 60 min between LLM synthesis calls
      const MIN_CLUSTER_SIZE = force ? 1 : 10; // raise threshold from 5 → 10

      const recentCluster = this.db.getRecentRawNodes(120, {
        dateStart: new Date(now - 600_000).toISOString()
      });

      if (recentCluster.length < MIN_CLUSTER_SIZE) return;
      if (!force && now - this.lastSynthesisAt < COOLDOWN_MS) {
        console.log("[Director] Synthesis skipped — cooldown active.");
        return;
      }
      if (!this.isActiveGeneration(generation)) return;
      const orderedCluster = [...recentCluster].sort((a, b) =>
        new Date(a.anchorAt || a.createdAt).getTime() - new Date(b.anchorAt || b.createdAt).getTime()
      );
      const rawSnapshotIds = orderedCluster.map((n) => n.id);
      if (this.hasEpisodeForCluster(rawSnapshotIds)) return;

      console.log(`[Director's Cut] Synthesizing ${recentCluster.length} snapshots into narrative Episode...`);
      this.lastSynthesisAt = now;
      this.synthesisInFlight = true;
      this.deferredSynthesisCount = Math.max(0, this.deferredSynthesisCount - 1);
      
      const appUsage: Record<string, number> = {};
      orderedCluster.forEach(n => {
        const app = n.metadata.app as string || "unknown";
        appUsage[app] = (appUsage[app] || 0) + 1;
      });
      
      const appSignature = Object.entries(appUsage)
        .sort((a, b) => b[1] - a[1])
        .map(([app, count]) => `${app}: ${Math.round((count / recentCluster.length) * 100)}%`)
        .join(", ");

      const evidenceBullets = orderedCluster.map((n) => this.makeRawEvidenceBullet(n));
      // Cap raw log at 4,000 chars — evidence bullets carry the signal
      const fullLog = orderedCluster
        .map((n) => `[${n.metadata.app || "unknown"}][${n.anchorAt || n.createdAt}] ${n.canonicalText.slice(0, 400)}`)
        .join("\n---\n").slice(0, 4000);
      const timeWindow = this.describeTimeWindow(orderedCluster);
      const fallbackEpisode = this.buildFallbackEpisode(orderedCluster, appSignature, evidenceBullets, timeWindow);
      
      const episodePrompt = `
You are the "Director of Human Memory". Your task is to perform "Lossy Compression" on a raw activity stream.
Turn these ${recentCluster.length} snapshots into a "Director's Cut" Episode.

Time Window:
${timeWindow}

Activity Log:
${fullLog.slice(0, 12000)}

Raw Evidence Bullets:
${evidenceBullets.map((bullet) => `- ${bullet}`).join("\n")}

### The Mission:
Identify the Narrative "Story" of this time block. Why was the user here? What did they do? What was the result?
The bullets must summarize the associated raw data directly, not generic activity labels. Mention concrete pages, files, commands, topics, or conversations whenever visible.

### Return ONLY a JSON object:
{
  "title": "Action-oriented title (e.g., 'Debugging WebSocket Bridge')",
  "narrative": "A 2-4 sentence executive summary. Must explain: Intent (Why), Action (What), and Outcome (Result).",
  "raw_summary_bullets": ["3-8 bullet points grounded in the raw evidence"],
  "behavioral": {
    "focus_score": 1-10,
    "vibe": "Deep Work" | "Scattered" | "Research" | "Communication",
    "app_signature": "${appSignature}"
  },
  "entities": {
    "people": ["Name (Platform)"],
    "technical_topics": ["Entity Name"],
    "status": "Resolved" | "Blocked" | "In Progress",
    "context": "e.g., Home Office, Mobile"
  },
  "primary_project": "Name of the project node this relates to"
}

Narrative Example: "Willem spent the session in VS Code fixing the WebSocket bridge. He identified a 403 error in manifest.json and added the nativeMessaging permission. Result: Connection successful."

Bullet Example:
- [Google Chrome][10:14] Read DuckDuckGo results and docs about Chrome extension native messaging permissions.
- [VS Code][10:22] Edited manifest.json to add nativeMessaging and host permission entries.
- [Terminal][10:31] Retried the bridge and moved past the earlier 403 error.`;

      try {
        const response = this.deepseek.hasApiKey() ? await this.deepseek.reason(episodePrompt) : "";
        if (!this.isActiveGeneration(generation)) return;
        const jsonMatch = response.match(/\{.*\}/s);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        const data = this.normalizeEpisodeData(parsed, fallbackEpisode, appSignature, evidenceBullets, orderedCluster, timeWindow);
        if (!this.isActiveGeneration(generation)) return;
        const episodeId = this.persistEpisode(data, orderedCluster);
        await this.vectors.upsertInteraction(episodeId, `${data.narrative}\n${data.raw_summary_bullets.join("\n")}`, new Date().toISOString(), {
          app: data.primary_project || orderedCluster[orderedCluster.length - 1]?.metadata.app || appName,
          windowTitle: data.title
        });
        if (!this.isActiveGeneration(generation)) return;
        this.linkEpisodeToSemanticProject(episodeId, data.primary_project, data.title);
      } catch (e) {
        if (!this.isActiveGeneration(generation) || this.isDatabaseClosedError(e)) return;
        console.error("[Director] Synthesis failed:", e);
        const episodeId = this.persistEpisode(fallbackEpisode, orderedCluster);
        await this.vectors.upsertInteraction(episodeId, `${fallbackEpisode.narrative}\n${fallbackEpisode.raw_summary_bullets.join("\n")}`, new Date().toISOString(), {
          app: fallbackEpisode.primary_project || orderedCluster[orderedCluster.length - 1]?.metadata.app || appName,
          windowTitle: fallbackEpisode.title
        });
        if (!this.isActiveGeneration(generation)) return;
        this.linkEpisodeToSemanticProject(episodeId, fallbackEpisode.primary_project, fallbackEpisode.title);
      }
    } catch (error) {
      if (!this.isActiveGeneration(generation) || this.isDatabaseClosedError(error)) {
        return;
      }
      throw error;
    } finally {
      this.synthesisInFlight = false;
    }
  }

  private hasEpisodeForCluster(rawSnapshotIds: string[]) {
    const idSet = new Set(rawSnapshotIds);
    return this.db.getMemoryNodes("EPISODE").some((episode) => {
      const existingIds = Array.isArray(episode.metadata?.raw_snapshot_ids) ? episode.metadata.raw_snapshot_ids : [];
      if (existingIds.length !== rawSnapshotIds.length) return false;
      return existingIds.every((id: string) => idSet.has(id));
    });
  }

  private makeRawEvidenceBullet(node: any) {
    const text = String(node.canonicalText || node.summary || "").replace(/\s+/g, " ").trim();
    const timestamp = new Date(node.anchorAt || node.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `[${node.metadata?.app || "unknown"}][${timestamp}] ${text.slice(0, 180)}`;
  }

  private describeTimeWindow(nodes: any[]) {
    const start = new Date(nodes[0]?.anchorAt || nodes[0]?.createdAt || Date.now());
    const end = new Date(nodes[nodes.length - 1]?.anchorAt || nodes[nodes.length - 1]?.createdAt || Date.now());
    return `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  private buildFallbackEpisode(nodes: any[], appSignature: string, evidenceBullets: string[], timeWindow: string) {
    const primaryApp = nodes[nodes.length - 1]?.metadata?.app || nodes[0]?.metadata?.app || "Unknown App";
    const title = `${primaryApp} work summary`;
    const narrative = `This episode covers ${nodes.length} raw captures between ${timeWindow}. The activity centered on ${primaryApp}, with the strongest visible evidence summarized below from the associated raw data. Outcome is uncertain because no explicit resolution signal was extracted.`;
    return {
      title,
      narrative,
      raw_summary_bullets: evidenceBullets.slice(0, 8),
      behavioral: {
        focus_score: Math.min(10, Math.max(3, nodes.length + 2)),
        vibe: nodes.length >= 5 ? "Deep Work" : "Research",
        app_signature: appSignature
      },
      entities: {
        people: [],
        technical_topics: [],
        status: "In Progress",
        context: primaryApp
      },
      primary_project: primaryApp,
      time_window: timeWindow
    };
  }

  private normalizeEpisodeData(
    parsed: any,
    fallback: any,
    appSignature: string,
    evidenceBullets: string[],
    nodes: any[],
    timeWindow: string
  ) {
    const vibe = parsed?.behavioral?.vibe;
    const allowedVibes = new Set(["Deep Work", "Scattered", "Research", "Communication"]);
    return {
      title: parsed?.title || fallback.title,
      narrative: parsed?.narrative || fallback.narrative,
      raw_summary_bullets: Array.isArray(parsed?.raw_summary_bullets) && parsed.raw_summary_bullets.length > 0
        ? parsed.raw_summary_bullets.slice(0, 8).map((bullet: string) => String(bullet).trim()).filter(Boolean)
        : evidenceBullets.slice(0, 8),
      behavioral: {
        focus_score: Number.isFinite(parsed?.behavioral?.focus_score) ? Math.max(1, Math.min(10, parsed.behavioral.focus_score)) : fallback.behavioral.focus_score,
        vibe: allowedVibes.has(vibe) ? vibe : fallback.behavioral.vibe,
        app_signature: parsed?.behavioral?.app_signature || appSignature
      },
      entities: {
        people: Array.isArray(parsed?.entities?.people) ? parsed.entities.people.slice(0, 10) : [],
        technical_topics: Array.isArray(parsed?.entities?.technical_topics) ? parsed.entities.technical_topics.slice(0, 12) : [],
        status: parsed?.entities?.status || fallback.entities.status,
        context: parsed?.entities?.context || fallback.entities.context
      },
      primary_project: parsed?.primary_project || fallback.primary_project,
      time_window: timeWindow,
      raw_snapshot_ids: nodes.map((node) => node.id)
    };
  }

  private persistEpisode(data: any, nodes: any[]) {
    const bullets = data.raw_summary_bullets.map((b: string) => `- ${b}`).join("\n");
    const episodeId = this.db.writeBatch(() => {
      const createdId = this.db.addMemoryNode({
        layer: "EPISODE",
        subtype: String(data.behavioral.vibe || "episode").toLowerCase().replace(/\s+/g, "-"),
        title: data.title,
        summary: data.narrative,
        sourceRefs: data.raw_snapshot_ids,
        canonicalText:
`NARRATIVE:
${data.narrative}

RAW EVIDENCE BULLETS:
${bullets}

BEHAVIORAL METADATA:
- Focus Score: ${data.behavioral.focus_score}/10
- Vibe: ${data.behavioral.vibe}
- App Signature: ${data.behavioral.app_signature}
- Time Window: ${data.time_window}

KEY ENTITIES:
- People Involved: ${(data.entities.people || []).join(", ") || "None"}
- Technical Nodes: ${(data.entities.technical_topics || []).join(", ") || "None"}
- Status / Outcome: ${data.entities.status || "Unknown"}
- Location / Context: ${data.entities.context || "Unknown"}`,
        metadata: {
          ...data.behavioral,
          ...data.entities,
          primary_project: data.primary_project,
          snapshot_count: nodes.length,
          raw_range: [nodes[0]?.id, nodes[nodes.length - 1]?.id],
          raw_snapshot_ids: data.raw_snapshot_ids,
          raw_summary_bullets: data.raw_summary_bullets,
          time_window: data.time_window,
          app: "Episode Synthesis"
        },
        importance: data.behavioral.focus_score > 7 ? 8 : 6,
        anchorAt: nodes[nodes.length - 1]?.anchorAt || new Date().toISOString()
      });

      for (const node of nodes) {
        this.db.addMemoryEdge(node.id, createdId, "PART_OF_EPISODE");
      }
      return createdId;
    });

    return episodeId;
  }

  private linkEpisodeToSemanticProject(episodeId: string, topicName: string, title: string) {
    if (!topicName || topicName.toLowerCase() === "unknown") return;
    const existing = this.db.getMemoryNodes("SEMANTIC").find((node) => node.title.toLowerCase() === topicName.toLowerCase());
    if (existing) {
      this.db.addMemoryEdge(episodeId, existing.id, "CONTRIBUTES_TO");
      return;
    }

    this.db.writeBatch(() => {
      const semanticId = this.db.addMemoryNode({
        layer: "SEMANTIC",
        subtype: "topic",
        title: topicName,
        summary: `Project identified via Episode: ${title}`,
        canonicalText: `Top-level concept for ${topicName}.`,
        importance: 7,
        metadata: { type: "Project", app: "Episode Synthesis" }
      });
      this.db.addMemoryEdge(episodeId, semanticId, "CONTRIBUTES_TO");
    });
  }

  private async runProactiveSearch() {
    if (this.proactivePulseInFlight) {
      return;
    }
    this.proactivePulseInFlight = true;
    try {
    console.log("[Proactive] Running background pulse...");
    
    // Stage 6.1: Social Decay Pulse Pulse
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const peopleNodes = this.db.getMemoryNodes("SEMANTIC").filter(n => n.subtype === "person");
    
    for (const person of peopleNodes) {
      if (person.updatedAt < sevenDaysAgo) {
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const recentContext = this.db.getMemoryNodesByFilters({
          dateStart: fortyEightHoursAgo
        }, 10);
        
        const edges = this.db.getMemoryEdges(person.id);
        const relatedToRecent = edges.filter(e => recentContext.some(n => n.id === e.toId || n.id === e.fromId));
        
        if (relatedToRecent.length > 0) {
          this.emit("nudge", {
            type: "social_decay",
            person: person.title,
            count: relatedToRecent.length
          });
        }
      }
    }
    } finally {
      this.proactivePulseInFlight = false;
    }
  }

  private async yieldToEventLoop() {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private applyOcrState(result: OcrCaptureResult) {
    this.update({
      activeApp: result.activeApp,
      activeBundleId: result.activeBundleId,
      activeWindowTitle: result.activeWindowTitle,
      screenPermission: result.permission,
      lastError: result.error,
      status: result.ok ? "running" : result.permission === "denied" ? "blocked" : "error"
    });
  }

  private persistActivitySpan(rawNodeId: string, result: OcrCaptureResult) {
    const app = result.activeApp || "unknown";
    const windowTitle = result.activeWindowTitle || "Untitled";
    const recentThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recentSpan = this.db
      .getRecentEpisodeNodes(20, { dateStart: recentThreshold, app, windowTitle, subtype: "activity_span" })
      .find((node) =>
        node.metadata?.app === app &&
        node.metadata?.windowTitle === windowTitle &&
        (node.anchorAt || node.createdAt) >= recentThreshold
      );

    if (!recentSpan) {
      this.db.writeBatch(() => {
        const spanId = this.db.addMemoryNode({
          layer: "EPISODE",
          subtype: "activity_span",
          title: `${app} activity span`,
          summary: `${app} in ${windowTitle}`,
          canonicalText: String(result.text || "").slice(0, 4000),
          sourceRefs: [rawNodeId],
          metadata: {
            app,
            windowTitle,
            startAt: result.timestamp,
            endAt: result.timestamp,
            rawSnapshotIds: [rawNodeId]
          },
          importance: 5,
          anchorAt: result.timestamp
        });
        this.db.addMemoryEdge(rawNodeId, spanId, "PART_OF_SPAN");
      });
      return;
    }

    const rawSnapshotIds = Array.isArray(recentSpan.metadata?.rawSnapshotIds) ? recentSpan.metadata.rawSnapshotIds : [];
    const nextRawSnapshotIds = [...new Set([...rawSnapshotIds, rawNodeId])];
    const nextText = `${String(recentSpan.canonicalText || "")}\n\n[${result.timestamp}] ${String(result.text || "").slice(0, 1200)}`.slice(0, 12000);
    this.db.writeBatch(() => {
      this.db.updateMemoryNode(recentSpan.id, {
        summary: `${app} in ${windowTitle} · ${nextRawSnapshotIds.length} captures`,
        canonicalText: nextText,
        metadata: {
          ...recentSpan.metadata,
          app,
          windowTitle,
          endAt: result.timestamp,
          rawSnapshotIds: nextRawSnapshotIds
        }
      });
      this.db.addMemoryEdge(rawNodeId, recentSpan.id, "PART_OF_SPAN");
    });
  }

  private refreshCadenceStatus() {
    const cadenceStatus = this.computeCadenceStatus();
    this.state = {
      ...this.state,
      cadenceStatus,
      queueDepth: this.computeQueueDepth(),
      indexQueueDepth: this.indexQueue.length + Number(this.indexInFlight),
      synthesisQueueDepth: this.synthesisQueue.length + Number(this.synthesisInFlight),
      skippedTicks: this.skippedTicks,
      captureLagMs: this.computeCaptureLagMs()
    };
    this.db.setSubsystemHealth("capture", {
      cadenceStatus,
      lastOcrAt: this.state.lastOcrAt,
      lastIndexedAt: this.state.lastIndexedAt,
      queueDepth: this.computeQueueDepth(),
      indexQueueDepth: this.indexQueue.length + Number(this.indexInFlight),
      synthesisQueueDepth: this.synthesisQueue.length + Number(this.synthesisInFlight),
      skippedTicks: this.skippedTicks,
      captureLagMs: this.computeCaptureLagMs(),
      ocrDurationMs: this.state.ocrDurationMs,
      captureDurationMs: this.state.captureDurationMs
    });
  }

  private computeCadenceStatus() {
    if (!this.captureEnabledProvider() || this.systemPaused) return "paused" as const;
    if (!this.state.lastOcrAt) return "stale" as const;
    const ageMs = Date.now() - new Date(this.state.lastOcrAt).getTime();
    return ageMs > 45_000 ? "stale" : "healthy";
  }

  private update(partial: Partial<CaptureState>) {
    this.state = { ...this.state, ...partial };
    this.emit("state", this.state);
  }

  private computeQueueDepth() {
    return Number(this.captureInFlight)
      + Number(this.indexInFlight)
      + Number(this.synthesisInFlight)
      + Number(this.historicalSynthesisInFlight)
      + Number(this.proactivePulseInFlight)
      + this.indexQueue.length
      + this.synthesisQueue.length
      + this.deferredSynthesisCount;
  }

  private computeCaptureLagMs() {
    if (!this.state.lastOcrAt) return undefined;
    const lag = Date.now() - new Date(this.state.lastOcrAt).getTime();
    return Number.isFinite(lag) ? Math.max(0, lag) : undefined;
  }

  private isActiveGeneration(generation: number) {
    return !this.stopped && generation === this.lifecycleGeneration;
  }

  private isDatabaseClosedError(error: unknown) {
    const message = String((error as any)?.message || error || "").toLowerCase();
    return message.includes("database closed");
  }

  private async shouldRunFullCapture() {
    const status = await this.ocr.status();
    this.applyOcrState(status);
    if (!status.ok) return false;
    const currentSignature = this.makeCaptureSignature(status);
    const stale = Date.now() - this.lastOcrSampleAt >= this.FULL_OCR_INTERVAL_MS;
    return !this.lastOcrSignature || currentSignature !== this.lastOcrSignature || stale;
  }

  private makeCaptureSignature(result: Pick<OcrCaptureResult, "activeApp" | "activeBundleId" | "activeWindowTitle">) {
    return [result.activeBundleId || "", result.activeApp || "", result.activeWindowTitle || ""].join("|");
  }

  private enqueueIndexWork(job: { nodeId: string; timestamp: string; app?: string; windowTitle?: string; text: string; result: OcrCaptureResult; generation: number }) {
    this.indexQueue.push(job);
    void this.processIndexQueue();
    this.refreshCadenceStatus();
  }

  private enqueueSynthesisWork(job: { nodeId: string; appName: string; rawText: string; force: boolean; generation: number }) {
    this.synthesisQueue.push(job);
    void this.processSynthesisQueue();
    this.refreshCadenceStatus();
  }

  private async processIndexQueue() {
    if (this.indexInFlight) return;
    this.indexInFlight = true;
    try {
      while (this.indexQueue.length > 0) {
        const job = this.indexQueue.shift();
        if (!job || !this.isActiveGeneration(job.generation)) continue;
        const startedAt = Date.now();
        this.persistActivitySpan(job.nodeId, job.result);
        await this.vectors.upsertInteraction(job.nodeId, `${summarizeLocally(job.text)}\n${job.text}`, job.timestamp, {
          app: job.app,
          windowTitle: job.windowTitle
        });
        this.db.setSubsystemHealth("capture", {
          lastIndexedAt: job.timestamp,
          queueDepth: this.computeQueueDepth(),
          indexQueueDepth: this.indexQueue.length + Number(this.indexInFlight),
          synthesisQueueDepth: this.synthesisQueue.length + Number(this.synthesisInFlight),
          retrievalCoverage: "raw node indexed",
          captureDurationMs: Math.max(this.state.captureDurationMs || 0, Date.now() - startedAt)
        });
        await this.yieldToEventLoop();
      }
    } finally {
      this.indexInFlight = false;
      this.refreshCadenceStatus();
    }
  }

  private async processSynthesisQueue() {
    if (this.synthesisInFlight) return;
    while (this.synthesisQueue.length > 0) {
      const job = this.synthesisQueue.shift();
      if (!job || !this.isActiveGeneration(job.generation)) continue;
      await this.synthesizeDetailedMemory(job.nodeId, job.appName, job.rawText, job.force, job.generation);
      await this.yieldToEventLoop();
    }
    this.refreshCadenceStatus();
  }
}
