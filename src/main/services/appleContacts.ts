import { execFile } from "node:child_process";
import path from "node:path";
import util from "node:util";
import type { WeaveDatabase } from "../db/client";
import type { IdentityService } from "./identity";

const execFileAsync = util.promisify(execFile);

export class AppleContactService {
  constructor(private db: WeaveDatabase, private identity: IdentityService) {}
  private isSyncing = false;

  private onProgress?: (progress: any) => void;
  setProgressListener(cb: (progress: any) => void) {
    this.onProgress = cb;
  }

  async sync() {
    if (this.isSyncing) {
      console.log("[AppleContacts] Sync skipped because another sync is already running.");
      return;
    }
    this.isSyncing = true;
    this.onProgress?.({ service: "apple", status: "syncing", processed: 0, total: 100 });
    console.log("[AppleContacts] Starting local sync...");
    const { app } = require("electron");
    const scriptPath = app.isPackaged 
      ? path.join((process as any).resourcesPath, "fetch_apple_contacts")
      : path.join(app.getAppPath(), "src/main/scripts/fetch_apple_contacts");

    
    try {
      const { stdout } = await execFileAsync(scriptPath);
      const contacts = JSON.parse(stdout);
      const existingContactKeys = this.buildExistingContactKeySet();
      
      const now = new Date().toISOString();
      let processed = 0;
      const createdRawNodes: any[] = [];
      for (const contact of contacts) {
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
      
      console.log(`[AppleContacts] Synced ${contacts.length} contacts.`);
      
      this.identity.processNewContacts(createdRawNodes);
      
      this.onProgress?.({ service: "apple", status: "completed", processed: 100, total: 100 });
    } catch (e: any) {
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
