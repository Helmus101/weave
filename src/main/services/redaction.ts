import { extractEntities } from "./extraction";

/**
 * Basic local redaction to avoid sending PII to cloud LLMs.
 * Returns both the redacted text and a prompt snippet for the LLM to understand.
 */
export function redactForCloud(text: string) {
  const entities = extractEntities(text);
  let redactedText = text;

  // Replacements list for the LLM prompt
  const replacements: Array<readonly [string, string]> = [
    ...entities.emails.map((value: string, index: number) => [value, `[EMAIL_${index + 1}]`] as const),
    ...entities.people.map((value: string, index: number) => [value, `[PERSON_${index + 1}]`] as const),
    ...entities.urls.map((value: string, index: number) => [value, `[URL_${index + 1}]`] as const)
  ];

  for (const [original, placeholder] of replacements) {
    redactedText = redactedText.split(original).join(placeholder);
  }

  redactedText = redactedText.replace(/\b(password|passcode|secret)\s*:\s*\S+/gi, (_match, label: string) => `${label}: [SECRET]`);
  redactedText = redactedText.replace(/\b(?:\d[ -]*?){13,19}\b/g, "[PAYMENT_CARD]");

  return {
    redactedText,
    entities,
    replacements
  };
}
