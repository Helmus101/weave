import type { WeaveDatabase } from "../db/client";
import type { ResearchService } from "./research";

export class IdentityService {
  constructor(private db: WeaveDatabase, private research: ResearchService) {}
  private queue: any[] = [];
  private processingQueue = false;
  private readonly BATCH_SIZE = 20;

  processNewContacts(rawNodes: any[]) {
    if (rawNodes.length === 0) return;
    this.queue.push(...rawNodes.filter((node) => node?.subtype === "contact"));
    if (!this.processingQueue) {
      void this.processQueue();
    }
  }

  private async processQueue() {
    this.processingQueue = true;
    try {
      console.log(`[Identity] Processing ${this.queue.length} queued contacts for merging...`);
      const peopleNodes = this.db.getMemoryNodes("SEMANTIC").filter(n => n.subtype === "person");
      const rawNodesSnapshot = this.db.getMemoryNodes("RAW");

      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.BATCH_SIZE);
        for (const raw of batch) {
          await this.processOneContact(raw, peopleNodes, rawNodesSnapshot);
        }
        await this.yieldToEventLoop();
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async processOneContact(raw: any, peopleNodes: any[], rawNodesSnapshot: any[]) {
    try {
      if (raw.subtype !== "contact") return;
      
      const meta = raw.metadata || {};
      const rawName = this.normalizeName(String(meta.name || raw.title || ""));
      const rawEmails = this.normalizeEmails(Array.isArray(meta.emails) ? meta.emails : []);
      const rawPhones = this.normalizePhones(Array.isArray(meta.phones) ? meta.phones : []);
      const rawOrg = String(meta.org || "").trim();
      if (!rawName) return;

      // Find match by normalized name, email overlap, or phone overlap.
      let match = peopleNodes.find(p => {
        const personName = this.normalizeName(p.title);
        if (personName && personName === rawName) return true;

        const pEmails = this.normalizeEmails(Array.isArray(p.metadata.emails) ? p.metadata.emails : []);
        if (this.hasOverlap(rawEmails, pEmails)) return true;

        const pPhones = this.normalizePhones(Array.isArray(p.metadata.phones) ? p.metadata.phones : []);
        if (this.hasOverlap(rawPhones, pPhones)) return true;

        return false;
      });

      if (match) {
        // Merge normalized contact data onto the existing person profile.
        const mergedEmails = Array.from(new Set([
          ...this.normalizeEmails(Array.isArray(match.metadata.emails) ? match.metadata.emails : []),
          ...rawEmails
        ]));
        const mergedPhones = Array.from(new Set([
          ...this.normalizePhones(Array.isArray(match.metadata.phones) ? match.metadata.phones : []),
          ...rawPhones
        ]));
        const mergedMeta = {
          ...match.metadata,
          emails: mergedEmails,
          phones: mergedPhones,
          name: match.title,
          org: match.metadata.org || rawOrg || undefined
        };
        
        this.db.updateMemoryNode(match.id, { metadata: mergedMeta });
        if (raw.id) {
          this.db.addMemoryEdge(raw.id, match.id, "IS_PERSON");
        }

        if (this.shouldRefreshEnrichment(match.metadata?.enrichmentUpdatedAt)) {
          await this.localEnrichment(match.id, match.title, mergedEmails, rawNodesSnapshot);
          void this.research.enrichPerson(match.id, match.title);
        }
      } else {
        // Create new person profile node.
        const newPersonId = this.db.addMemoryNode({
          layer: "SEMANTIC",
          subtype: "person",
          title: raw.title,
          summary: `Profile for ${raw.title}`,
          canonicalText: `Identity: ${raw.title}\nEmails: ${rawEmails.join(", ")}\nPhones: ${rawPhones.join(", ")}`,
          metadata: { type: "Person", emails: rawEmails, phones: rawPhones, name: raw.title, org: rawOrg || undefined },
          importance: 6
        });
        if (raw.id) {
          this.db.addMemoryEdge(raw.id, newPersonId, "IS_PERSON");
        }
        
        // Add to array for subsequent checks in this batch
        peopleNodes.push(this.db.getMemoryNode(newPersonId)!);
        
        // Enrich with local and external data.
        await this.localEnrichment(newPersonId, raw.title, rawEmails, rawNodesSnapshot);
        void this.research.enrichPerson(newPersonId, raw.title);
      }
    } catch (e) {
      console.error("[Identity] Failed processing contact:", e);
    }
  }

  private async localEnrichment(personId: string, personName: string, emails: string[], rawNodesSnapshot: any[]) {
    const person = this.db.getMemoryNode(personId);
    if (!person) return;
    
    try {
      const keywords = Array.from(new Set([
        ...emails,
        this.normalizeName(personName)
      ].filter(Boolean)));

      const rawNodes = rawNodesSnapshot.filter(n => {
        const text = (n.canonicalText || "").toLowerCase();
        return keywords.some((k) => text.includes(k));
      }).slice(0, 80);

      const edges = this.db.getMemoryEdges(personId);
      const linkedNodeIds = Array.from(new Set(edges.map((edge) => edge.fromId === personId ? edge.toId : edge.fromId).filter((id) => id !== personId)));
      const linkedNodes = linkedNodeIds
        .map((id) => this.db.getMemoryNode(id))
        .filter((node): node is NonNullable<typeof node> => Boolean(node));

      const relatedEvents = this.db.searchEventsByKeywords(keywords, 10);

      const existingEdgeKeys = new Set(edges.map((edge) => `${edge.fromId}:${edge.toId}:${edge.relation}`));
      for (const node of rawNodes) {
        const keyA = `${node.id}:${personId}:ASSOCIATED_WITH`;
        const keyB = `${personId}:${node.id}:ASSOCIATED_WITH`;
        if (!existingEdgeKeys.has(keyA) && !existingEdgeKeys.has(keyB)) {
          this.db.addMemoryEdge(node.id, personId, "ASSOCIATED_WITH");
          existingEdgeKeys.add(keyA);
        }
      }

      const rawNodeSummary = rawNodes
        .slice(0, 6)
        .map((node) => `${node.subtype || "raw"}: ${node.title}`)
        .join(" | ") || "No matching raw memory nodes.";

      const eventSummary = relatedEvents
        .slice(0, 6)
        .map((event) => `${event.type}@${event.timestamp}: ${(event.text || "").replace(/\s+/g, " ").slice(0, 90)}`)
        .join(" | ") || "No matching raw events.";

      const linkedSummary = linkedNodes
        .slice(0, 8)
        .map((node) => `${node.layer}:${node.title}`)
        .join(" | ") || "No linked nodes yet.";

      const enrichment = `Local memory summary for ${personName}: raw_nodes=${rawNodes.length}, raw_events=${relatedEvents.length}, linked_nodes=${linkedNodes.length}.`;
      const localMemorySummary = [
        `RAW NODES: ${rawNodeSummary}`,
        `RAW EVENTS: ${eventSummary}`,
        `LINKED GRAPH: ${linkedSummary}`
      ].join("\n");

      const updatedMeta = {
        ...person.metadata,
        localEnrichment: enrichment,
        localMemorySummary,
        enrichmentUpdatedAt: new Date().toISOString()
      };

      const cleanedCanonical = person.canonicalText.replace(/\n\nLOCAL MEMORY SUMMARY:[\s\S]*$/m, "");
      const nextCanonical = `${cleanedCanonical}\n\nLOCAL MEMORY SUMMARY:\n${localMemorySummary}`;

      this.db.updateMemoryNode(personId, { metadata: updatedMeta, canonicalText: nextCanonical });
    } catch (e) {
      console.error("[Identity] Local enrichment failed:", e);
    }
  }

  private normalizeName(value: string): string {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeEmails(values: string[]): string[] {
    return Array.from(new Set(
      values
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    ));
  }

  private normalizePhones(values: string[]): string[] {
    return Array.from(new Set(
      values
        .map((value) => String(value || "").replace(/[^\d+]/g, "").trim())
        .filter(Boolean)
    ));
  }

  private hasOverlap(a: string[], b: string[]): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const setB = new Set(b);
    return a.some((item) => setB.has(item));
  }

  private shouldRefreshEnrichment(iso?: string): boolean {
    if (!iso) return true;
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return true;
    return (Date.now() - then) > 24 * 60 * 60 * 1000;
  }

  private async yieldToEventLoop() {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
