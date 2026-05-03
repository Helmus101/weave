import { describe, expect, it } from "vitest";
import { extractEntities, extractIntents } from "../main/services/extraction";
import { redactForCloud } from "../main/services/redaction";
import { isBlacklisted } from "../main/services/blacklist";

describe("extraction", () => {
  it("extracts people, emails, dates, urls, and intents", () => {
    const text = "Mark Chen said let's grab coffee next Tuesday. Email mark@example.com and see https://example.com";
    expect(extractEntities(text)).toMatchObject({
      people: ["Mark Chen"],
      emails: ["mark@example.com"],
      dates: ["next Tuesday"],
      urls: ["https://example.com"]
    });
    expect(extractIntents(text)[0]).toContain("let's grab coffee next Tuesday");
  });
});

describe("redaction", () => {
  it("redacts sensitive cloud payload fields", () => {
    const result = redactForCloud("Mark Chen password: hunter2 mark@example.com card 4242 4242 4242 4242");
    expect(result.redactedText).toContain("[PERSON_1]");
    expect(result.redactedText).toContain("[EMAIL_1]");
    expect(result.redactedText).toContain("[PAYMENT_CARD]");
    expect(result.redactedText).toContain("password: [SECRET]");
  });
});

describe("blacklist", () => {
  it("matches bundle ids, app names, and titles", () => {
    expect(isBlacklisted({ appName: "1Password" }, ["1password"], [])).toBe(true);
    expect(isBlacklisted({ bundleId: "com.apple.Notes" }, ["bank"], [])).toBe(false);
    expect(isBlacklisted({ title: "Business Banking" }, [], ["banking"])).toBe(true);
  });
});
