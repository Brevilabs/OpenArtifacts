/**
 * The one rule for a display name, shared by the name a person sets
 * (`PUT …/account`), the name a provider sends at sign-in, and the name derived
 * from an email: trimmed, 1 to 64 characters, no control characters.
 */

/** The longest display name, after trimming. */
export const MAX_NAME = 64;

/** Control characters and the two Unicode line separators, which no name has. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

/** The name as it is stored, or null when it is not a valid one. */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim();
  return name.length < 1 || name.length > MAX_NAME || CONTROL.test(name) ? null : name;
}

/** The name a person with none is shown under: their email before the `@`, else "Reader". */
export function nameFromEmail(email: string): string {
  return normalizeDisplayName(email.split("@")[0]) ?? "Reader";
}
