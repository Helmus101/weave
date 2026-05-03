import { execFile } from "node:child_process";
import util from "node:util";
import fs from "node:fs";
import type { WeaveDatabase } from "../db/client";
import type { IdentityService } from "./identity";

const execFileAsync = util.promisify(execFile);

export class AppleContactService {
  constructor(
    private db: WeaveDatabase,
    private identity: IdentityService,
    private binaryPath: string
  ) {}
  private isSyncing = false;
  private stopped = false;
  private syncGeneration = 0;

  private onProgress?: (progress: any) => void;
  setProgressListener(cb: (progress: any) => void) {
    this.onProgress = cb;
  }

  stop() {
    this.stopped = true;
    this.syncGeneration += 1;
  }

  async getPermissionStatus(): Promise<"granted" | "denied" | "unknown"> {
    try {
      if (!fs.existsSync(this.binaryPath)) {
        return "unknown";
      }
      await execFileAsync(this.binaryPath);
      return "granted";
    } catch (error: any) {
      const message = String(error?.message || error || "").toLowerCase();
      if (message.includes("permission denied") || message.includes("operation not permitted")) {
        return "denied";
      }
      return "unknown";
    }
  }

  async sync() {
    if (this.stopped) return;
    if (this.isSyncing) {
      console.log("[AppleContacts] Sync skipped because another sync is already running.");
      return;
    }
    this.isSyncing = true;
    const generation = ++this.syncGeneration;
    this.onProgress?.({ service: "apple", status: "syncing", processed: 0, total: 100 });
    console.log("[AppleContacts] Starting local sync...");

    
    try {
      if (!fs.existsSync(this.binaryPath)) {
        throw new Error("Apple Contacts bridge is not built. Run npm run build:contacts.");
      }
      const { stdout } = await execFileAsync(this.binaryPath);
      if (this.stopped || generation !== this.syncGeneration) return;
      const contacts = JSON.parse(stdout);
      const existingContactKeys = this.buildExistingContactKeySet();
      
      const now = new Date().toISOString();
      let processed = 0;
      const createdRawNodes: any[] = [];
      for (const contact of contacts) {
        if (this.stopped || generation !== this.syncGeneration) return;
        processed++;
        if (!contact.name) continue;
        
        this.onProgress?.({ 
          service: "apple", 
          status: "syncing", 
          processed, 
          total: contacts.length,
          currentContact: contact.name
        });
        
        const emails = contact.emails || [];
        const phones = contact.phones || [];
        const org = contact.organization || "";
        const dedupeKey = this.makeContactKey(contact.name, emails, phones);
        if (existingContactKeys.has(dedupeKey)) {
          continue;
        }
        
        const text = `Name: ${contact.name}\nEmails: ${emails.join(", ")}\nPhones: ${phones.join(", ")}\nOrg: ${org}`;
        
        const eventId = this.db.addEvent({
          type: "contact",
          timestamp: now,
          source: "apple_contacts",
          text
        });

        const nodeId = this.db.addMemoryNode({
          layer: "RAW",
          subtype: "contact",
          title: contact.name,
          summary: `Apple Contact: ${contact.name}`,
          canonicalText: text,
          sourceRefs: [eventId],
          anchorAt: now,
          metadata: { app: "Apple Contacts", emails, phones, name: contact.name, org }
        });
        const rawNode = this.db.getMemoryNode(nodeId);
        if (rawNode) createdRawNodes.push(rawNode);
        existingContactKeys.add(dedupeKey);

        if (processed % 40 === 0) {
          await this.yieldToEventLoop();
        }
      }
      
      if (this.stopped || generation !== this.syncGeneration) return;
      console.log(`[AppleContacts] Synced ${contacts.length} contacts.`);
      
      this.identity.processNewContacts(createdRawNodes);
      this.db.setSubsystemHealth("appleContacts", {
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: undefined,
        lastFailureMessage: undefined
      });
      
      this.onProgress?.({ service: "apple", status: "completed", processed: 100, total: 100 });
    } catch (e: any) {
      if (this.stopped || generation !== this.syncGeneration) return;
      this.db.setSubsystemHealth("appleContacts", {
        lastFailureAt: new Date().toISOString(),
        lastFailureMessage: e.message
      });
      this.onProgress?.({ service: "apple", status: "error", processed: 0, error: e.message });
      const isPermissionError = e.message.includes("Permission denied") || e.message.includes("Operation not permitted");
      const helpfulError = isPermissionError 
        ? "Access to Contacts was denied. Please allow Weave in System Settings > Privacy & Security > Contacts."
        : e.message;
      console.error("[AppleContacts] Sync failed:", helpfulError);
    } finally {
      this.isSyncing = false;
    }
  }

  private buildExistingContactKeySet(): Set<string> {
    const set = new Set<string>();
    const existingRawContacts = this.db.getMemoryNodes("RAW").filter((node) => node.subtype === "contact");
    for (const node of existingRawContacts) {
      const name = String(node.metadata?.name || node.title || "");
      const emails = Array.isArray(node.metadata?.emails) ? node.metadata.emails : [];
      const phones = Array.isArray(node.metadata?.phones) ? node.metadata.phones : [];
      set.add(this.makeContactKey(name, emails, phones));
    }
    return set;
  }

  private makeContactKey(name: string, emails: string[], phones: string[]): string {
    const normalizedName = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedEmails = [...new Set((emails || []).map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))].sort();
    const normalizedPhones = [...new Set((phones || []).map((phone) => String(phone || "").replace(/[^\d+]/g, "").trim()).filter(Boolean))].sort();
    return `${normalizedName}|${normalizedEmails.join(",")}|${normalizedPhones.join(",")}`;
  }

  private async yieldToEventLoop() {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
