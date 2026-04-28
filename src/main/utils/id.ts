import { randomBytes } from "node:crypto";

export function createId(): string {
  return randomBytes(16).toString("base64url");
}
