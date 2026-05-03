import { google } from "googleapis";
import { createHash, randomBytes } from "node:crypto";
import type { GoogleAuthStatus } from "../../shared/types";
import type { WeaveDatabase } from "../db/client";
import { extractEntities, extractIntents, summarizeLocally } from "./extraction";
import type { GoogleTokenStore } from "./secureStorage";

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
  private pendingAuth?: { state: string; codeVerifier: string };
  private stopped = false;
  private syncGeneration = 0;
  private readonly AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
  private readonly CONTACT_SYNC_INTERVAL_MS = 60 * 60 * 1000;
  private readonly CONTACT_SYNC_KEY = "google_contacts_last_sync_at";

  constructor(
    private db: WeaveDatabase,
    private clientProvider: () => { clientId?: string; clientSecret?: string },
    private tokenStore: GoogleTokenStore,
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
    void this.sync().catch(e => console.error("[Google] Startup auto-sync failed:", e));
    this.syncTimer = setInterval(() => {
      this.sync().catch(e => console.error("[Google] Auto-sync failed:", e));
    }, this.AUTO_SYNC_INTERVAL_MS);
  }

  async status(): Promise<GoogleAuthStatus> {
    const account = this.db.googleAccount();
    const tokens = await this.tokenStore.load();
    const configured = this.hasClient();
    
    let error: string | undefined = undefined;

    if (configured && !tokens?.refreshToken) {
    } else if (!configured && !tokens?.refreshToken) {
      error = "Google Client ID and Secret not set in .env";
    }

    return {
      connected: Boolean(tokens?.refreshToken),
      email: account?.email,
      lastSyncAt: account?.last_sync_at,
      error
    };
  }

  private authServer?: import("node:http").Server;

  async startAuth(): Promise<GoogleAuthStatus> {
    const s = await this.status();
    if (!s.connected && !s.error) {
      const { shell } = require("electron");
      const http = require("node:http");
      const authUrl = this.authUrl();

      if (this.authServer) {
        this.authServer.close();
      }

      return new Promise<GoogleAuthStatus>((resolve) => {
        this.authServer = http.createServer(async (req: any, res: any) => {
          const requestUrl = new URL(req.url || "/", "http://127.0.0.1:3001");
          if (requestUrl.pathname !== "/oauth2callback") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found.");
            return;
          }

          const code = requestUrl.searchParams.get("code");
          const returnedState = requestUrl.searchParams.get("state");
          if (code && returnedState && this.pendingAuth?.state === returnedState) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Authentication successful!</h1><p>You can close this tab now and return to the Weave app.</p><script>setTimeout(() => window.close(), 1000);</script></body></html>");
            
            // Bring the Electron app window to focus
            try {
              const { app, BrowserWindow } = require("electron");
              const windows = BrowserWindow.getAllWindows();
              if (windows.length > 0) {
                windows[0].focus();
              }
            } catch (e) {
              // Silently fail if Electron API not available
            }
            
            if (this.authServer) {
              this.authServer.close();
              this.authServer = undefined;
            }
            
            try {
              const newStatus = await this.finishAuth(code);
              resolve(newStatus);
            } catch (e: any) {
              resolve({ ...s, error: `Auth failed: ${e.message}` });
            } finally {
              this.pendingAuth = undefined;
            }
          } else {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid request. Missing auth code or invalid state.");
          }
        });
        
        this.authServer?.listen(3001, async () => {
          await shell.openExternal(authUrl);
        });
      });
    }
    return s;
  }

  async finishAuth(code: string): Promise<GoogleAuthStatus> {
    const oauth2 = this.oauth();
    const { tokens } = await oauth2.getToken({
      code,
      codeVerifier: this.pendingAuth?.codeVerifier
    });
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
    await this.tokenStore.save(tokens);
    this.db.upsertGoogleAccount({
      email: me.data.email ?? undefined,
      expiryDate: tokens.expiryDate,
      scopes
    });
    // Trigger an immediate sync to populate context
    this.sync().catch(e => console.error("[Google] Initial sync after token set failed:", e));
    return this.status();
  }


  async sync(): Promise<GoogleAuthStatus> {
    if (this.stopped) return this.status();
    if (this.isSyncing) {
      console.log("[Google] Sync skipped because another sync is already running.");
      return this.status();
    }
    if (this.watcher && !this.watcher.canRunBackgroundWork()) {
      console.log("[Google] Sync deferred because capture/indexing is under load.");
      return this.status();
    }

    const account = this.db.googleAccount();
    const tokens = await this.tokenStore.load();
    if (!tokens?.refreshToken) return this.status();
    this.isSyncing = true;
    const startedAt = Date.now();
    const generation = ++this.syncGeneration;
    const oauth2 = this.oauth();
    oauth2.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const peopleApi = google.people({ version: "v1", auth: oauth2 });

    const now = new Date();
    const isInitialSync = !account?.last_sync_at;
    const since = isInitialSync ? new Date("2010-01-01T00:00:00Z") : new Date(account?.last_sync_at || "2010-01-01T00:00:00Z");
    const shouldSyncContacts = isInitialSync || this.shouldSyncContacts(now);
    
    console.log(`[Google] Starting sync. Initial: ${isInitialSync}, Since: ${since.toISOString()}`);

    this.onProgress?.({ service: "google", status: "syncing", processed: 0, total: 100 });

    const newRawNodes: any[] = [];

    try {
      // 1. Sync Contacts
      if (shouldSyncContacts) {
        const connections = await peopleApi.people.connections.list({
          resourceName: "people/me",
          personFields: "names,emailAddresses,phoneNumbers",
          pageSize: isInitialSync ? 1000 : 250
        });
        if (this.stopped || generation !== this.syncGeneration) return this.status();
        
        const contacts = connections.data.connections ?? [];
        const existingContactKeys = this.buildExistingContactKeySet();
        let processed = 0;
        for (const person of contacts) {
          if (this.stopped || generation !== this.syncGeneration) return this.status();
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
          const nodeId = this.db.writeBatch(() => {
            const eventId = this.db.addEvent({
              type: "contact",
              timestamp: now.toISOString(),
              source: "google_contacts",
              text
            });

            return this.db.addMemoryNode({
              layer: "RAW",
              subtype: "contact",
              title: name,
              summary: `Google Contact: ${name}`,
              canonicalText: text,
              sourceRefs: [eventId],
              anchorAt: now.toISOString(),
              metadata: { app: "Google Contacts", emails, phones, name }
            });
          });
          newRawNodes.push(this.db.getMemoryNode(nodeId));
          existingContactKeys.add(dedupeKey);

          if (processed % 25 === 0) {
            await this.yieldToEventLoop();
          }
        }

        this.db.kvSet(this.CONTACT_SYNC_KEY, now.toISOString(), "text");

        if (this.identity) {
          if (!this.stopped && generation === this.syncGeneration) {
            this.identity.processNewContacts(newRawNodes);
          }
        }
      }
      
      // 2. Sync Calendar
      const weekOut = new Date(now.getTime() + 7 * 86_400_000);
      const events = await calendar.events.list({
        calendarId: "primary",
        timeMin: since.toISOString(),
        timeMax: weekOut.toISOString(),
        maxResults: isInitialSync ? 2500 : 25,
        singleEvents: true,
        orderBy: "startTime"
      });
      if (this.stopped || generation !== this.syncGeneration) return this.status();

      let calendarProcessed = 0;
      for (const event of events.data.items ?? []) {
        if (this.stopped || generation !== this.syncGeneration) return this.status();
        calendarProcessed++;
        const text = `${event.summary ?? "Calendar event"} ${(event.attendees ?? []).map((attendee) => attendee.email).join(" ")}`;
        const occurredAt = event.start?.dateTime ?? event.start?.date ?? new Date().toISOString();
        
        const nodeId = this.db.writeBatch(() => {
          const eventId = this.db.addEvent({
            type: "calendar",
            timestamp: occurredAt,
            source: "google_calendar",
            text: text
          });

          return this.db.addMemoryNode({
            layer: "RAW",
            subtype: "calendar_event",
            title: event.summary ?? "Calendar Event",
            summary: summarizeLocally(text),
            canonicalText: text,
            sourceRefs: [eventId],
            anchorAt: occurredAt,
            metadata: { app: "Google Calendar" }
          });
        });
        newRawNodes.push(this.db.getMemoryNode(nodeId));
        if (calendarProcessed % 10 === 0) {
          await this.yieldToEventLoop();
        }
      }

      // 3. Sync Gmail
      const q = isInitialSync ? "after:2010/01/01" : `after:${Math.floor(since.getTime() / 1000)}`;
      const messages = await gmail.users.messages.list({ userId: "me", maxResults: isInitialSync ? 500 : 20, q });
      if (this.stopped || generation !== this.syncGeneration) return this.status();
      
      let gmailProcessed = 0;
      for (const message of messages.data.messages ?? []) {
        if (this.stopped || generation !== this.syncGeneration) return this.status();
        gmailProcessed++;
        const detail = await gmail.users.messages.get({ userId: "me", id: message.id!, format: "full" });
        const headers = detail.data.payload?.headers ?? [];
        const bodyText = this.extractGmailBody(detail.data.payload);
        const text = [
          ...headers
            .filter((header) => ["From", "To", "Cc", "Bcc", "Subject", "Date"].includes(String(header.name || "")))
            .map((header) => `${header.name}: ${header.value}`),
          "",
          detail.data.snippet ?? "",
          bodyText ? `\nBODY:\n${bodyText}` : ""
        ].filter(Boolean).join("\n");
        const occurredAt = new Date(Number(detail.data.internalDate ?? Date.now())).toISOString();
        const subject = headers.find(h => h.name === "Subject")?.value || "Email";
        const threadId = detail.data.threadId || undefined;
        const messageId = detail.data.id || undefined;

        const nodeId = this.db.writeBatch(() => {
          const eventId = this.db.addEvent({
            type: "gmail",
            timestamp: occurredAt,
            source: "google_gmail",
            text: text,
            metadata: {
              app: "Gmail",
              subject,
              threadId,
              messageId
            }
          });

          return this.db.addMemoryNode({
            layer: "RAW",
            subtype: "email",
            title: subject,
            summary: summarizeLocally(text),
            canonicalText: text,
            sourceRefs: [eventId],
            anchorAt: occurredAt,
            metadata: {
              app: "Gmail",
              subject,
              threadId,
              messageId,
              rawSource: "google_gmail"
            }
          });
        });
        newRawNodes.push(this.db.getMemoryNode(nodeId));
        if (gmailProcessed % 5 === 0) {
          await this.yieldToEventLoop();
        }
      }

      // 4. Historical Backfill Synthesis
      if (isInitialSync && this.watcher && newRawNodes.length > 0) {
        console.log(`[Google] Initial sync complete. Passing ${newRawNodes.length} raw nodes to watcher for historical synthesis...`);
        // We process only calendar and email events for historical episodes (skip contacts, those are for identity service)
        const historicalEvents = newRawNodes.filter(n => n?.subtype === "email" || n?.subtype === "calendar_event");
        if (historicalEvents.length > 0 && this.watcher.canRunBackgroundWork()) {
          if (this.stopped || generation !== this.syncGeneration) return this.status();
          await this.watcher.synthesizeHistoricalBatch(historicalEvents);
        }
      }

      if (this.stopped || generation !== this.syncGeneration) return this.status();
      this.db.markGoogleSynced();
      this.db.setSubsystemHealth("googleSync", {
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: undefined,
        lastFailureMessage: undefined,
        lastGoogleSyncDurationMs: Date.now() - startedAt
      });
      this.onProgress?.({ service: "google", status: "completed", processed: 100, total: 100 });
      return this.status();
    } catch (e: any) {
      if (this.stopped || generation !== this.syncGeneration) return this.status();
      const isUnauthorizedClient = e.response?.data?.error === 'unauthorized_client';
      const errorMsg = isUnauthorizedClient 
        ? "Google Auth Error: Client ID mismatch. Local .env credentials do not match these tokens."
        : e.message;

      console.error("[Google] Sync failed:", e.message);
      
      if (isUnauthorizedClient) {
        console.warn("[Google] Clearing invalid tokens to stop unauthorized retry loop.");
        await this.tokenStore.clear();
        this.db.clearGoogleTokens();
      }

      this.db.setSubsystemHealth("googleSync", {
        lastFailureAt: new Date().toISOString(),
        lastFailureMessage: errorMsg,
        lastGoogleSyncDurationMs: Date.now() - startedAt
      });

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

  private shouldSyncContacts(now: Date) {
    const lastSyncAt = this.db.kvGet<string>(this.CONTACT_SYNC_KEY);
    const lastTs = new Date(String(lastSyncAt || "")).getTime();
    if (!Number.isFinite(lastTs)) return true;
    return (now.getTime() - lastTs) >= this.CONTACT_SYNC_INTERVAL_MS;
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

  private extractGmailBody(payload: any): string {
    const parts: string[] = [];

    const visit = (node: any) => {
      if (!node) return;
      const mimeType = String(node.mimeType || "");
      const data = node.body?.data;
      if (typeof data === "string" && data.length > 0 && (mimeType.startsWith("text/plain") || mimeType.startsWith("text/html") || !mimeType)) {
        const decoded = this.decodeBase64Url(data);
        const normalized = mimeType.startsWith("text/html")
          ? decoded.replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<[^>]+>/g, " ")
          : decoded;
        const compact = normalized.replace(/\r/g, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
        if (compact) parts.push(compact);
      }
      for (const child of node.parts || []) {
        visit(child);
      }
    };

    visit(payload);
    return Array.from(new Set(parts)).join("\n\n").slice(0, 12000);
  }

  private decodeBase64Url(value: string): string {
    try {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return Buffer.from(padded, "base64").toString("utf8");
    } catch {
      return "";
    }
  }

  private hasClient() {
    const client = this.clientProvider();
    return Boolean(client.clientId && client.clientSecret);
  }

  private authUrl() {
    const state = randomBytes(16).toString("hex");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.pendingAuth = { state, codeVerifier };
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
      state,
      code_challenge_method: "S256" as any,
      code_challenge: codeChallenge
    });
  }

  private oauth() {
    const client = this.clientProvider();
    if (!client.clientId || !client.clientSecret) {
      throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment before connecting Google.");
    }
    return new google.auth.OAuth2(client.clientId, client.clientSecret, "http://localhost:3001/oauth2callback");
  }

  stop() {
    this.stopped = true;
    this.syncGeneration += 1;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
    if (this.authServer) {
      this.authServer.close();
      this.authServer = undefined;
    }
    this.pendingAuth = undefined;
  }

  async clearCredentials() {
    await this.tokenStore.clear();
    this.db.clearGoogleTokens();
  }
}
