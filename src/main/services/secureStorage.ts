import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GoogleTokenPayload {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
}

export class GoogleTokenStore {
  constructor(private namespace: string) {}

  async load(): Promise<GoogleTokenPayload | undefined> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        this.serviceName(),
        "-a",
        this.accountName(),
        "-w"
      ]);
      const raw = stdout.trim();
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as GoogleTokenPayload;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async save(tokens: GoogleTokenPayload): Promise<void> {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      this.serviceName(),
      "-a",
      this.accountName(),
      "-w",
      JSON.stringify(tokens)
    ]);
  }

  async clear(): Promise<void> {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s",
        this.serviceName(),
        "-a",
        this.accountName()
      ]);
    } catch {
      // Missing keychain item is fine.
    }
  }

  private serviceName() {
    return "Weave Google OAuth";
  }

  private accountName() {
    return this.namespace || "default";
  }
}

export class AppSecretStore {
  constructor(private namespace = "global") {}

  load(key: string): string | undefined {
    try {
      const stdout = execFileSync("security", [
        "find-generic-password",
        "-s",
        this.serviceName(),
        "-a",
        this.accountName(key),
        "-w"
      ], { encoding: "utf8" });
      const value = stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  save(key: string, value: string) {
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-s",
      this.serviceName(),
      "-a",
      this.accountName(key),
      "-w",
      value
    ]);
  }

  clear(key: string) {
    try {
      execFileSync("security", [
        "delete-generic-password",
        "-s",
        this.serviceName(),
        "-a",
        this.accountName(key)
      ]);
    } catch {
      // Missing keychain item is fine.
    }
  }

  private serviceName() {
    return "Weave App Secret";
  }

  private accountName(key: string) {
    return `${this.namespace}:${key}`;
  }
}
