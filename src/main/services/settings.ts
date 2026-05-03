import fs from "node:fs";
import path from "node:path";
import { AppSecretStore } from "./secureStorage";

interface SettingsFile {
  captureEnabled: boolean;
  rawCloudAllowed: boolean;
  publicMcpUrl?: string;
  externalContactResearchAllowed: boolean;
  quickChatShortcut?: string;
  blacklistedApps: string[];
  blacklistedWebsites: string[];
  activeAccountId?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  deepseekApiKey?: string;
}

const DEFAULT_BLACKLISTED_APPS = [
  "System Settings",
  "System Preferences",
  "Security & Privacy",
  "Keychain Access",
  "Passwords",
  "1Password",
  "LastPass",
  "Bitwarden",
  "Authy",
  "Okta Verify",
  "Terminal",
  "iTerm2",
  "Console",
  "Activity Monitor",
  "Messages",
  "Signal"
];

const DEFAULT_BLACKLISTED_WEBSITES = [
  "localhost",
  "127.0.0.1",
  "bank.com",
  "login",
  "signin",
  "auth",
  "password",
  "2fa",
  "mfa",
  "otp",
  "banking",
  "payment",
  "checkout",
  "wallet",
  "tax",
  "payroll",
  "benefits",
  "medical",
  "health"
];

const LEGACY_QUICK_CHAT_SHORTCUT = "CommandOrControl+Shift+K";
const PREVIOUS_QUICK_CHAT_SHORTCUT = "Command+W";
const DEFAULT_QUICK_CHAT_SHORTCUT = "Alt+W";

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

const defaults: SettingsFile = {
  captureEnabled: false,
  rawCloudAllowed: false,
  externalContactResearchAllowed: false,
  quickChatShortcut: DEFAULT_QUICK_CHAT_SHORTCUT,
  blacklistedApps: DEFAULT_BLACKLISTED_APPS,
  blacklistedWebsites: DEFAULT_BLACKLISTED_WEBSITES
};

export class SettingsService {
  private filePath: string;
  private data: SettingsFile;
  private secrets: AppSecretStore;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "settings.json");
    this.secrets = new AppSecretStore("settings");
    this.data = this.load();
  }

  get captureEnabled() {
    return this.data.captureEnabled;
  }

  setCaptureEnabled(enabled: boolean) {
    this.data.captureEnabled = enabled;
    this.save();
  }

  get rawCloudAllowed() {
    return this.data.rawCloudAllowed;
  }

  setRawCloudAllowed(enabled: boolean) {
    this.data.rawCloudAllowed = enabled;
    this.save();
  }

  get publicMcpUrl() {
    return String(this.data.publicMcpUrl || "").trim() || undefined;
  }

  setPublicMcpUrl(url?: string) {
    const next = String(url || "").trim();
    this.data.publicMcpUrl = next || undefined;
    this.save();
  }

  get externalContactResearchAllowed() {
    return this.data.externalContactResearchAllowed;
  }

  setExternalContactResearchAllowed(enabled: boolean) {
    this.data.externalContactResearchAllowed = enabled;
    this.save();
  }

  get activeAccountId() {
    return this.data.activeAccountId;
  }

  get quickChatShortcut() {
    return this.data.quickChatShortcut || defaults.quickChatShortcut || DEFAULT_QUICK_CHAT_SHORTCUT;
  }

  setQuickChatShortcut(accelerator: string) {
    this.data.quickChatShortcut = String(accelerator || "").trim() || defaults.quickChatShortcut;
    this.save();
  }

  setActiveAccountId(accountId?: string) {
    this.data.activeAccountId = accountId && accountId !== "default" ? accountId : undefined;
    this.save();
  }

  get blacklistedApps() {
    return this.data.blacklistedApps || [];
  }

  setBlacklistedApps(apps: string[]) {
    this.data.blacklistedApps = unique(apps);
    this.save();
  }

  get blacklistedWebsites() {
    return this.data.blacklistedWebsites || [];
  }

  setBlacklistedWebsites(websites: string[]) {
    this.data.blacklistedWebsites = unique(websites);
    this.save();
  }

  deepseekApiKey(): string | undefined {
    return process.env.DEEPSEEK_API_KEY || this.secrets.load("deepseek-api-key");
  }

  hasDeepseekApiKey(): boolean {
    return Boolean(this.deepseekApiKey());
  }

  setDeepseekApiKey(apiKey?: string) {
    const next = String(apiKey || "").trim();
    if (next) {
      this.secrets.save("deepseek-api-key", next);
    } else {
      this.secrets.clear("deepseek-api-key");
    }
  }

  googleClient() {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID ?? this.secrets.load("google-client-id"),
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? this.secrets.load("google-client-secret")
    };
  }

  snapshot() {
    return {
      captureEnabled: this.data.captureEnabled,
      rawCloudAllowed: this.data.rawCloudAllowed,
      publicMcpUrl: this.publicMcpUrl,
      externalContactResearchAllowed: this.data.externalContactResearchAllowed,
      quickChatShortcut: this.quickChatShortcut,
      deepseekConfigured: this.hasDeepseekApiKey(),
      blacklistedApps: this.blacklistedApps,
      blacklistedWebsites: this.blacklistedWebsites
    };
  }

  private load(): SettingsFile {
    try {
      if (!fs.existsSync(this.filePath)) return { ...defaults };
      const saved = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SettingsFile;
      if (typeof saved.deepseekApiKey === "string" && saved.deepseekApiKey.trim()) {
        this.secrets.save("deepseek-api-key", saved.deepseekApiKey.trim());
        delete saved.deepseekApiKey;
      }
      if (typeof saved.googleClientId === "string" && saved.googleClientId.trim()) {
        this.secrets.save("google-client-id", saved.googleClientId.trim());
        delete saved.googleClientId;
      }
      if (typeof saved.googleClientSecret === "string" && saved.googleClientSecret.trim()) {
        this.secrets.save("google-client-secret", saved.googleClientSecret.trim());
        delete saved.googleClientSecret;
      }
      const next: SettingsFile = {
        ...defaults,
        ...saved,
        blacklistedApps: unique([...(defaults.blacklistedApps || []), ...(saved.blacklistedApps || [])]),
        blacklistedWebsites: unique([...(defaults.blacklistedWebsites || []), ...(saved.blacklistedWebsites || [])])
      };
      if (
        !saved.quickChatShortcut ||
        saved.quickChatShortcut === LEGACY_QUICK_CHAT_SHORTCUT ||
        saved.quickChatShortcut === PREVIOUS_QUICK_CHAT_SHORTCUT
      ) {
        next.quickChatShortcut = DEFAULT_QUICK_CHAT_SHORTCUT;
      }
      this.data = next;
      this.saveSanitizedSettingsFile();
      return next;
    } catch {
      return { ...defaults };
    }
  }

  private save() {
    this.saveSanitizedSettingsFile();
  }

  private saveSanitizedSettingsFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const sanitized: SettingsFile = {
      captureEnabled: this.data.captureEnabled,
      rawCloudAllowed: this.data.rawCloudAllowed,
      publicMcpUrl: this.publicMcpUrl,
      externalContactResearchAllowed: this.data.externalContactResearchAllowed,
      quickChatShortcut: this.data.quickChatShortcut,
      blacklistedApps: this.data.blacklistedApps,
      blacklistedWebsites: this.data.blacklistedWebsites,
      activeAccountId: this.data.activeAccountId
    };
    fs.writeFileSync(this.filePath, JSON.stringify(sanitized, null, 2));
  }
}
