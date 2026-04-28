import type { ExtractedEntities } from "../../shared/types";

const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const urlRegex = /\bhttps?:\/\/[^\s<>"']+/gi;
const dateRegex = /\b(?:today|tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b/gi;
const personRegex = /\b([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}|@[a-zA-Z][\w.-]{2,})\b/g;
const intentRegex = /(?:let'?s|we should|can you|please|follow up|circle back|grab coffee|schedule|send me|i'?ll send|next time|remind me)[^.?!\n]{0,160}/gi;

export function extractEntities(text: string): ExtractedEntities {
  const emails = unique(text.match(emailRegex) ?? []);
  const urls = unique(text.match(urlRegex) ?? []);
  const dates = unique(text.match(dateRegex) ?? []);
  const people = unique(
    Array.from(text.matchAll(personRegex), (match) => match[1])
      .map((name) => name.replace(/^@/, ""))
      .filter((name) => !name.includes("."))
      .filter((name) => !["Google Calendar", "New Message", "Screen Recording"].includes(name))
  ).slice(0, 12);

  return { people, emails, dates, urls };
}

export function extractIntents(text: string): string[] {
  return unique((text.match(intentRegex) ?? []).map((intent) => intent.trim())).slice(0, 8);
}

export function summarizeLocally(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No readable screen text captured.";
  return compact.length <= 220 ? compact : `${compact.slice(0, 217)}...`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
