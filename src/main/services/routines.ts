import type { RoutineDefinition, RoutineRun, RoutineSourceOptions, RoutineTemplate, SourceReceipt } from "../../shared/types";
import type { WeaveDatabase } from "../db/client";
import type { RetrievalService } from "./retrieval";
import type { IntelligenceEngine } from "./intelligence";
import { createId } from "../utils/id";

const ROUTINES_KEY = "routine_definitions";
const ROUTINE_RUNS_KEY = "routine_runs";

const DEFAULT_SOURCES: RoutineSourceOptions = {
  memory: true,
  calendar: true,
  contacts: false,
  web: true
};

const BUILT_IN_TEMPLATES: RoutineTemplate[] = [
  {
    id: "morning-briefing",
    title: "Morning Briefing",
    description: "A concise daily kickoff with motivation, priorities, rollovers, calendar prep, and positive news.",
    defaultCadence: "daily",
    defaultTimeOfDay: "08:00",
    sources: { memory: true, calendar: true, contacts: false, web: true },
    prompt: `Act as my personal productivity coach and assistant. I need a concise, motivational 5-minute readout to kickstart my workday.

Please include:
- Morning Briefing Title: Today's Date
- Daily Motivation: one fresh motivational quote
- Background Productivity: recommend 2 focus videos or music options
- Top 3 Priorities: why they matter this week and 1 suggested task each
- Rollovers: carry-over tasks, key follow-ups, and 1-3 wins from yesterday
- Calendar Snapshot: today's meetings and prep needed
- Leadership Mindset:
  - What would make today feel successful?
  - Where can I show up as a leader?
  - What am I avoiding that can be addressed quickly?
- Quick Info:
  - One positive, relevant headline
  - Three articles from the past week I would care about

Tone: calm, motivational, practical. Keep it readable in under 5 minutes.`
  },
  {
    id: "end-of-day-wrap",
    title: "End-of-Day Wrap",
    description: "Summarize progress, wins, unresolved loops, and tomorrow setup.",
    defaultCadence: "daily",
    defaultTimeOfDay: "18:00",
    sources: { memory: true, calendar: true, contacts: false, web: false },
    prompt: `Create an end-of-day wrap-up. Include:
- What got done
- What remains open
- What should roll into tomorrow
- A short reflection on wins and momentum
- One recommendation for a clean start tomorrow morning`
  },
  {
    id: "weekly-planning",
    title: "Weekly Planning",
    description: "Turn recent context into a weekly plan with priorities and risks.",
    defaultCadence: "weekly",
    defaultTimeOfDay: "08:30",
    sources: { memory: true, calendar: true, contacts: true, web: false },
    prompt: `Prepare a weekly planning note. Include top goals, constraints, likely blockers, key meetings, relationship follow-ups, and a suggested focus plan for the week.`
  },
  {
    id: "relationship-catch-up",
    title: "Relationship Catch-up",
    description: "Review important people, follow-ups, and timely reconnection opportunities.",
    defaultCadence: "weekdays",
    defaultTimeOfDay: "16:00",
    sources: { memory: true, calendar: false, contacts: true, web: false },
    prompt: `Review my recent relationship context and identify the most important people to follow up with. Include why now, the relevant memory signals, and a suggested opener for each.`
  },
  {
    id: "meeting-prep",
    title: "Meeting Prep",
    description: "Prepare for upcoming meetings using memory, calendar, and prior context.",
    defaultCadence: "weekdays",
    defaultTimeOfDay: "07:30",
    sources: { memory: true, calendar: true, contacts: true, web: false },
    prompt: `Create a concise meeting prep brief for today's meetings. Include likely topics, people involved, context from recent work, and the single most important prep step for each meeting.`
  }
];

export class RoutineService {
  private interval: NodeJS.Timeout | null = null;
  private runningRoutineIds = new Set<string>();
  private readonly SCHEDULE_WINDOW_MS = 90 * 1000;

  constructor(
    private db: WeaveDatabase,
    private retrieval: RetrievalService,
    private intelligence: IntelligenceEngine
  ) {}

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.runDueRoutines();
    }, 60_000);
    setTimeout(() => {
      void this.runDueRoutines();
    }, 45_000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  getTemplates() {
    return BUILT_IN_TEMPLATES;
  }

  getRoutines(): RoutineDefinition[] {
    return (this.db.kvGet<RoutineDefinition[]>(ROUTINES_KEY) || []).sort((a, b) => a.title.localeCompare(b.title));
  }

  saveRoutine(input: Partial<RoutineDefinition>): RoutineDefinition {
    const existing = this.getRoutines();
    const now = new Date().toISOString();
    const current = input.id ? existing.find((routine) => routine.id === input.id) : undefined;
    const template = input.templateId ? this.getTemplates().find((candidate) => candidate.id === input.templateId) : undefined;

    const next: RoutineDefinition = {
      id: current?.id || input.id || createId(),
      templateId: input.templateId || current?.templateId || template?.id,
      kind: input.kind || current?.kind || (template ? "template" : "custom"),
      title: input.title || current?.title || template?.title || "Custom Routine",
      description: input.description || current?.description || template?.description,
      prompt: input.prompt || current?.prompt || template?.prompt || "",
      cadence: input.cadence || current?.cadence || template?.defaultCadence || "manual",
      enabled: typeof input.enabled === "boolean" ? input.enabled : current?.enabled ?? true,
      timeOfDay: input.timeOfDay || current?.timeOfDay || template?.defaultTimeOfDay,
      weekday: typeof input.weekday === "number" ? input.weekday : current?.weekday ?? 1,
      sources: input.sources || current?.sources || template?.sources || DEFAULT_SOURCES,
      tone: input.tone || current?.tone,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      lastRunAt: input.lastRunAt ?? current?.lastRunAt
    };

    const remaining = existing.filter((routine) => routine.id !== next.id);
    this.db.kvSet(ROUTINES_KEY, [...remaining, next], "json");
    return next;
  }

  deleteRoutine(id: string) {
    const remaining = this.getRoutines().filter((routine) => routine.id !== id);
    this.db.kvSet(ROUTINES_KEY, remaining, "json");
  }

  getRuns(routineId?: string): RoutineRun[] {
    const runs = this.db.kvGet<RoutineRun[]>(ROUTINE_RUNS_KEY) || [];
    const trimmed = runs
      .slice(0, 40)
      .map((run) => ({
        ...run,
        receipts: Array.isArray(run.receipts) ? run.receipts.slice(0, 12) : []
      }))
      .filter((run) => !routineId || run.routineId === routineId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (runs.length > 40) {
      this.db.kvSet(ROUTINE_RUNS_KEY, trimmed, "json");
    }
    return trimmed;
  }

  getRun(id: string) {
    return this.getRuns().find((run) => run.id === id);
  }

  async runRoutineNow(id: string): Promise<RoutineRun> {
    if (this.runningRoutineIds.has(id)) {
      throw new Error("Routine is already running.");
    }
    const routine = this.getRoutines().find((candidate) => candidate.id === id);
    if (!routine) throw new Error("Routine not found.");
    this.runningRoutineIds.add(id);
    const startedAt = Date.now();

    try {
      const { context, receipts } = await this.buildRoutineContext(routine);
      const prompt = `
You are Weave. Generate a saved routine briefing for the user.

ROUTINE TITLE:
${routine.title}

ROUTINE PROMPT:
${routine.prompt}

TONE:
${routine.tone || "Calm, concise, evidence-first, useful."}

AVAILABLE CONTEXT:
${context}

AVAILABLE RECEIPTS:
${this.formatReceipts(receipts)}

RULES:
- Keep the answer concise but complete.
- Use inline receipts like [Memory][App][Time] or [Web][Title] for factual claims when possible.
- Distinguish clearly between observation, inference, and recommendation.
- Do not mention internal provider names.
- This is an in-app saved briefing, not a chat reply.
`;
      const content = await this.intelligence.generateDirectly(prompt);
      const run: RoutineRun = {
        id: createId(),
        routineId: routine.id,
        title: `${routine.title} · ${new Date().toLocaleString()}`,
        prompt: routine.prompt,
        content,
        createdAt: new Date().toISOString(),
        receipts
      };

      this.persistRun(run);
      this.saveRoutine({ ...routine, lastRunAt: run.createdAt });
      this.db.setSubsystemHealth("capture", {
        lastRoutineDurationMs: Date.now() - startedAt
      });
      return run;
    } finally {
      this.runningRoutineIds.delete(id);
    }
  }

  private async runDueRoutines() {
    if (!this.canSpendBackgroundBudget()) return;
    const routines = this.getRoutines().filter((routine) => routine.enabled && routine.cadence !== "manual");
    for (const routine of routines) {
      if (!this.isDue(routine)) continue;
      try {
        await this.runRoutineNow(routine.id);
      } catch (error) {
        console.error(`[Routines] Failed running ${routine.title}:`, error);
      }
    }
  }

  private isDue(routine: RoutineDefinition) {
    const now = new Date();
    if (routine.cadence === "weekdays" && (now.getDay() === 0 || now.getDay() === 6)) return false;
    if (routine.cadence === "weekly" && now.getDay() !== (routine.weekday ?? 1)) return false;

    const lastRun = routine.lastRunAt ? new Date(routine.lastRunAt) : null;
    const scheduledAt = this.buildScheduledDate(now, routine.timeOfDay || "08:00");
    if (now.getTime() < scheduledAt.getTime()) return false;
    if (now.getTime() >= scheduledAt.getTime() + this.SCHEDULE_WINDOW_MS) return false;

    if (!lastRun) return true;
    if (!Number.isFinite(lastRun.getTime())) return true;
    if (lastRun.getTime() >= scheduledAt.getTime()) return false;

    if (routine.cadence === "daily" || routine.cadence === "weekdays") {
      return !this.isSameCalendarDay(lastRun, now);
    }

    if (routine.cadence === "weekly") {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      return lastRun.getTime() < startOfWeek.getTime();
    }

    return false;
  }

  private buildScheduledDate(base: Date, value: string) {
    const [hours, minutes] = value.split(":").map((part) => Number(part));
    const scheduled = new Date(base);
    scheduled.setSeconds(0, 0);
    scheduled.setHours(hours || 0, minutes || 0, 0, 0);
    return scheduled;
  }

  private canSpendBackgroundBudget() {
    const captureHealth = this.db.getSubsystemHealth().capture || {};
    const queueDepth = Number(captureHealth.queueDepth || 0);
    const captureLagMs = Number(captureHealth.captureLagMs || 0);
    return queueDepth < 4 && captureLagMs < 90_000;
  }

  private isSameCalendarDay(left: Date, right: Date) {
    return left.getFullYear() === right.getFullYear()
      && left.getMonth() === right.getMonth()
      && left.getDate() === right.getDate();
  }

  private async buildRoutineContext(routine: RoutineDefinition): Promise<{ context: string; receipts: SourceReceipt[] }> {
    const sections: string[] = [];
    const receipts: SourceReceipt[] = [];
    const query = `${routine.title}\n${routine.prompt}`;

    if (routine.sources.memory) {
      const searchRes = await this.retrieval.searchWithTrace(query, 10, { layers: ["RAW", "EPISODE", "INSIGHT", "SEMANTIC"] });
      sections.push(`MEMORY CONTEXT:\n${searchRes.results.map((result) => `${result.title}: ${result.snippet}`).join("\n")}`);
      receipts.push(...this.retrieval.buildMemoryReceipts(searchRes.results));
      receipts.push(...this.retrieval.buildRawReceipts(searchRes.results));
    }

    if (routine.sources.calendar) {
      const calendarEvents = this.db.getRecentEventsBySource("google_calendar", 12).slice(0, 8);
      sections.push(`CALENDAR CONTEXT:\n${calendarEvents.map((event) => `[${event.timestamp}] ${event.text || ""}`).join("\n") || "No calendar context."}`);
      receipts.push(...calendarEvents.map((event, index) => ({
        id: `calendar-${index}-${event.id}`,
        kind: "event" as const,
        title: "Calendar Event",
        snippet: String(event.text || "").replace(/\s+/g, " ").slice(0, 220),
        timestamp: event.timestamp,
        eventId: event.id,
        reason: "Google Calendar context"
      })));
    }

    if (routine.sources.contacts) {
      const people = this.db.getMemoryNodes("SEMANTIC").filter((node) => node.subtype === "person").slice(0, 10);
      sections.push(`CONTACT CONTEXT:\n${people.map((person) => `${person.title}: ${person.summary}`).join("\n") || "No contact context."}`);
      receipts.push(...people.map((person, index) => ({
        id: `contact-${index}-${person.id}`,
        kind: "memory" as const,
        title: person.title,
        snippet: String(person.summary || person.canonicalText || "").replace(/\s+/g, " ").slice(0, 220),
        nodeId: person.id,
        layer: person.layer,
        reason: "Contact relationship context"
      })));
    }

    if (routine.sources.web) {
      const web = await this.retrieval.performWebSearchDetailed(`${routine.title} ${new Date().toLocaleDateString()}`);
      sections.push(`WEB CONTEXT:\n${web.text}`);
      receipts.push(...web.receipts);
    }

    return {
      context: sections.filter(Boolean).join("\n\n"),
      receipts: receipts.slice(0, 20)
    };
  }

  private persistRun(run: RoutineRun) {
    const runs = this.getRuns();
    this.db.kvSet(ROUTINE_RUNS_KEY, [{
      ...run,
      receipts: run.receipts.slice(0, 12)
    }, ...runs].slice(0, 40), "json");
  }

  private formatReceipts(receipts: SourceReceipt[]) {
    if (receipts.length === 0) return "No receipts available.";
    return receipts.slice(0, 12).map((receipt) => {
      if (receipt.kind === "web") {
        return `[Web][${receipt.title}] ${receipt.snippet}${receipt.url ? ` (${receipt.url})` : ""}`;
      }
      return `[Memory][${receipt.app || receipt.layer || "context"}][${receipt.timestamp || "unknown"}] ${receipt.title}: ${receipt.snippet}`;
    }).join("\n");
  }
}
