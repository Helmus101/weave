import { google } from "googleapis";
import type { GoogleAuthStatus } from "../../shared/types";
import type { WeaveDatabase } from "../db/client";
import { extractEntities, extractIntents, summarizeLocally } from "./extraction";

const scopes = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "openid",
  "email"
];

import type { WatcherService } from "./watcher";
import type { IdentityService } from "./identity";

export class GoogleService {
  private syncTimer?: NodeJS.Timeout;
  private isSyncing = false;

  constructor(
    private db: WeaveDatabase,
    private clientProvider: () => { clientId?: string; clientSecret?: string },
    private watcher?: WatcherService,
    private identity?: IdentityService
  ) {
    this.startAutoSync();
  }

  private onProgress?: (progress: any) => void;
  setProgressListener(cb: (progress: any) => void) {
    this.onProgress = cb;
  }

  private startAutoSync() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      this.sync().catch(e => console.error("[Google] Auto-sync failed:", e));
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  status(): GoogleAuthStatus {
    const account = this.db.googleAccount();
    const configured = this.hasClient();
    
    let authUrl: string | undefined = undefined;
    let error: string | undefined = undefined;

    if (configured && !account?.refresh_token) {
      try {
        authUrl = this.authUrl();
      } catch (e: any) {
        error = e.message;
      }
    } else if (!configured && !account?.refresh_token) {
      error = "Google Client ID and Secret not set in .env";
    }

    return {
      connected: Boolean(account?.refresh_token),
      email: account?.email,
      lastSyncAt: account?.last_sync_at,
      authUrl,
      error
    };
  }

  private authServer?: import("node:http").Server;

  async startAuth(): Promise<GoogleAuthStatus> {
    const s = this.status();
    if (s.authUrl) {
      const { shell } = require("electron");
      const http = require("node:http");
      const url = require("node:url");

      if (this.authServer) {
        this.authServer.close();
      }

      return new Promise<GoogleAuthStatus>((resolve) => {
        this.authServer = http.createServer(async (req: any, res: any) => {
          const qs = url.parse(req.url, true).query;
          if (qs.code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Authentication successful!</h1><p>You can close this tab now and return to the Weave app.</p><script>window.close()</script></body></html>");
            
            if (this.authServer) {
              this.authServer.close();
              this.authServer = undefined;
            }
            
            try {
              const newStatus = await this.finishAuth(qs.code as string);
              resolve(newStatus);
            } catch (e: any) {
              resolve({ ...s, error: `Auth failed: ${e.message}` });
            }
          } else {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid request. Missing auth code.");
          }
        });
        
        this.authServer?.listen(3001, async () => {
          await shell.openExternal(s.authUrl!);
        });
      });
    } else if (!s.error && !s.connected) {
      return { ...s, error: "Unable to generate Auth URL. Check .env configuration." };
    }
    return s;
  }

  async finishAuth(code: string): Promise<GoogleAuthStatus> {
    const oauth2 = this.oauth();
    const { tokens } = await oauth2.getToken(code);
    return this.setTokens({
      accessToken: tokens.access_token ?? undefined,
      refreshToken: tokens.refresh_token ?? undefined,
      expiryDate: tokens.expiry_date ?? undefined
    });
  }

  async setTokens(tokens: { accessToken?: string; refreshToken?: string; expiryDate?: number }): Promise<GoogleAuthStatus> {
    const oauth2 = this.oauth();
    oauth2.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate
    });
    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
    const me = await oauth2Api.userinfo.get();
    this.db.upsertGoogleAccount({
      email: me.data.email ?? undefined,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiryDate: tokens.expiryDate,
      scopes
    });
    // Trigger an immediate sync to populate context
    this.sync().catch(e => console.error("[Google] Initial sync after token set failed:", e));
    return this.status();
  }


  async sync(): Promise<GoogleAuthStatus> {
    if (this.isSyncing) {
      console.log("[Google] Sync skipped because another sync is already running.");
      return this.status();
    }

    const account = this.db.googleAccount();
    if (!account?.refresh_token) return this.status();
    this.isSyncing = true;
    const oauth2 = this.oauth();
    oauth2.setCredentials({ refresh_token: account.refresh_token });

    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const peopleApi = google.people({ version: "v1", auth: oauth2 });

    const now = new Date();
    const isInitialSync = !account.last_sync_at;
    const since = isInitialSync ? new Date("2010-01-01T00:00:00Z") : new Date(account.last_sync_at!);
    
    console.log(`[Google] Starting sync. Initial: ${isInitialSync}, Since: ${since.toISOString()}`);

    this.onProgress?.({ service: "google", status: "syncing", processed: 0, total: 100 });

    const newRawNodes: any[] = [];

    try {
      // 1. Sync Contacts
      const connections = await peopleApi.people.connections.list({
        resourceName: "people/me",
        personFields: "names,emailAddresses,phoneNumbers",
        pageSize: 1000
      });
      
      const contacts = connections.data.connections ?? [];
      const existingContactKeys = this.buildExistingContactKeySet();
      let processed = 0;
      for (const person of contacts) {
        processed++;
        const name = person.names?.[0]?.displayName;
        if (!name) continue;
        
        this.onProgress?.({ 
          service: "google", 
          status: "syncing", 
          processed, 
          total: contacts.length,
          currentContact: name
        });
        
        const emails = person.emailAddresses?.map(e => e.value).filter((value): value is string => typeof value === "string" && value.length > 0) || [];
        const phones = person.phoneNumbers?.map(p => p.value).filter((value): value is string => typeof value === "string" && value.length > 0) || [];
        const dedupeKey = this.makeContactKey(name, emails, phones);
        if (existingContactKeys.has(dedupeKey)) {
          continue;
        }

        const text = `Name: ${name}\nEmails: ${emails.join(", ")}\nPhones: ${phones.join(", ")}`;
        
        const eventId = this.db.addEvent({
          type: "contact",
          timestamp: now.toISOString(),
          source: "google_contacts",
          text
        });

        const nodeId = this.db.addMemoryNode({
          layer: "RAW",
          subtype: "contact",
          title: name,
          summary: `Google Contact: ${name}`,
          canonicalText: text,
          sourceRefs: [eventId],
          anchorAt: now.toISOString(),
          metadata: { app: "Google Contacts", emails, phones, name }
        });
        newRawNodes.push(this.db.getMemoryNode(nodeId));
        existingContactKeys.add(dedupeKey);

        if (processed % 40 === 0) {
          await this.yieldToEventLoop();
        }
      }

      if (this.identity) {
        this.identity.processNewContacts(newRawNodes);
      }
      
      // 2. Sync Calendar
      const weekOut = new Date(now.getTime() + 7 * 86_400_000);
      const events = await calendar.events.list({
        calendarId: "primary",
        timeMin: since.toISOString(),
        timeMax: weekOut.toISOString(),
        maxResults: isInitialSync ? 2500 : 50,
        singleEvents: true,
        orderBy: "startTime"
      });

      for (const event of events.data.items ?? []) {
        const text = `${event.summary ?? "Calendar event"} ${(event.attendees ?? []).map((attendee) => attendee.email).join(" ")}`;
        const occurredAt = event.start?.dateTime ?? event.start?.date ?? new Date().toISOString();
        
        const eventId = this.db.addEvent({
          type: "calendar",
          timestamp: occurredAt,
          source: "google_calendar",
          text: text
        });

        const nodeId = this.db.addMemoryNode({
          layer: "RAW",
          subtype: "calendar_event",
          title: event.summary ?? "Calendar Event",
          summary: summarizeLocally(text),
          canonicalText: text,
          sourceRefs: [eventId],
          anchorAt: occurredAt,
          metadata: { app: "Google Calendar" }
        });
        newRawNodes.push(this.db.getMemoryNode(nodeId));
      }

      // 3. Sync Gmail
      const q = isInitialSync ? "after:2010/01/01" : `after:${Math.floor(since.getTime() / 1000)}`;
      const messages = await gmail.users.messages.list({ userId: "me", maxResults: isInitialSync ? 500 : 50, q });
      
      for (const message of messages.data.messages ?? []) {
        const detail = await gmail.users.messages.get({ userId: "me", id: message.id!, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
        const headers = detail.data.payload?.headers ?? [];
        const text = [...headers.map((header) => `${header.name}: ${header.value}`), detail.data.snippet ?? ""].join("\n");
        const occurredAt = new Date(Number(detail.data.internalDate ?? Date.now())).toISOString();
        const subject = headers.find(h => h.name === "Subject")?.value || "Email";

        const eventId = this.db.addEvent({
          type: "gmail",
          timestamp: occurredAt,
          source: "google_gmail",
          text: text
        });

        const nodeId = this.db.addMemoryNode({
          layer: "RAW",
          subtype: "email",
          title: subject,
          summary: summarizeLocally(text),
          canonicalText: text,
          sourceRefs: [eventId],
          anchorAt: occurredAt,
          metadata: { app: "Gmail" }
        });
        newRawNodes.push(this.db.getMemoryNode(nodeId));
      }

      // 4. Historical Backfill Synthesis
      if (isInitialSync && this.watcher && newRawNodes.length > 0) {
        console.log(`[Google] Initial sync complete. Passing ${newRawNodes.length} raw nodes to watcher for historical synthesis...`);
        // We process only calendar and email events for historical episodes (skip contacts, those are for identity service)
        const historicalEvents = newRawNodes.filter(n => n?.subtype === "email" || n?.subtype === "calendar_event");
        if (historicalEvents.length > 0) {
          await this.watcher.synthesizeHistoricalBatch(historicalEvents);
        }
      }

      this.db.markGoogleSynced();
      this.onProgress?.({ service: "google", status: "completed", processed: 100, total: 100 });
      return this.status();
    } catch (e: any) {
      const isUnauthorizedClient = e.response?.data?.error === 'unauthorized_client';
      const errorMsg = isUnauthorizedClient 
        ? "Google Auth Error: Client ID mismatch. Local .env credentials do not match these tokens."
        : e.message;

      console.error("[Google] Sync failed:", e.message);
      
      if (isUnauthorizedClient) {
        console.warn("[Google] Clearing invalid tokens to stop unauthorized retry loop.");
        this.db.clearGoogleTokens();
      }

      this.onProgress?.({ 
        service: "google", 
        status: "error", 
        processed: 0, 
        total: 100, 
        error: errorMsg 
      });
      return this.status();
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

  private hasClient() {
    const client = this.clientProvider();
    return Boolean(client.clientId && client.clientSecret);
  }

  private authUrl() {
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes
    });
  }

  private oauth() {
    const client = this.clientProvider();
    if (!client.clientId || !client.clientSecret) {
      throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment before connecting Google.");
    }
    return new google.auth.OAuth2(client.clientId, client.clientSecret, "http://localhost:3001/oauth2callback");
  }
}
