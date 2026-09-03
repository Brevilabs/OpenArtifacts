/**
 * The one way a secret becomes a database key.
 *
 * Three credentials are looked up by hash rather than by value — a Brevilabs
 * license key, an OpenArtifacts token, and the device code a terminal polls
 * with — and they all have to agree on what "the hash" means, since a mismatch
 * would not be a bug that fails, it would be a credential that silently never
 * matches. It lives in its own module because `src/auth.ts` and `src/db.ts`
 * both need it and neither should import the other.
 */

/** Lowercase hex SHA-256, which is the form every `*_hash` column stores. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
