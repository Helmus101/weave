import fs from "node:fs";
import path from "node:path";

interface SettingsFile {
  captureEnabled: boolean;
  rawCloudAllowed: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  blacklistedApps: string[];
  blacklistedWebsites: string[];
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

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

const defaults: SettingsFile = {
  captureEnabled: false,
  rawCloudAllowed: false,
  blacklistedApps: DEFAULT_BLACKLISTED_APPS,
  blacklistedWebsites: DEFAULT_BLACKLISTED_WEBSITES
};

export class SettingsService {
  private filePath: string;
  private data: SettingsFile;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "settings.json");
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
    return process.env.DEEPSEEK_API_KEY || this.data.deepseekApiKey;
  }

  googleClient() {

    return {
      clientId: process.env.GOOGLE_CLIENT_ID ?? this.data.googleClientId,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? this.data.googleClientSecret
    };
  }

  snapshot() {
    return {
      captureEnabled: this.data.captureEnabled,
      rawCloudAllowed: this.data.rawCloudAllowed,
      blacklistedApps: this.blacklistedApps,
      blacklistedWebsites: this.blacklistedWebsites
    };
  }

  private load(): SettingsFile {
    try {
      if (!fs.existsSync(this.filePath)) return { ...defaults };
      const saved = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        ...defaults,
        ...saved,
        blacklistedApps: unique([...(defaults.blacklistedApps || []), ...(saved.blacklistedApps || [])]),
        blacklistedWebsites: unique([...(defaults.blacklistedWebsites || []), ...(saved.blacklistedWebsites || [])])
      };
    } catch {
      return { ...defaults };
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
