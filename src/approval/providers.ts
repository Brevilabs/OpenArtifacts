/**
 * The identity providers an approval can be proved with, and the one thing this
 * repo wants out of either of them: an email address the provider says it has
 * verified.
 *
 * Nothing else about the person is read, stored, or asked for. No name, no
 * avatar, no provider account id — an account here is an id and an email, and
 * scopes are kept to the minimum that yields one.
 *
 * **A verified email is the entire security argument.** `accounts.email` is
 * unique, so an address is a claim on an account and everything that account
 * has published. A provider that let someone assert an address they do not own
 * would therefore be handing over documents, which is why an unverified address
 * is refused outright rather than accepted and flagged. Google says so in the
 * id token's `email_verified`; GitHub says so per address on its emails
 * endpoint, and only the primary verified one counts.
 *
 * The handshakes themselves are arctic's. Arctic reaches the network through
 * the global `fetch`, so `OAuthClient` is the seam tests replace: the two
 * functions that decide whether an email is acceptable live here as plain data
 * transforms, and they are tested directly.
 */
import { decodeIdToken, GitHub, Google } from "arctic";
import type { Env } from "../config.js";

export const PROVIDER_IDS = ["google", "github"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** What the approval page prints on the button. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: "Google",
  github: "GitHub",
};

/**
 * Least privilege, and both providers give it: Google's `openid email` yields
 * an id token with the address and its verification flag and nothing else,
 * GitHub's `user:email` reads addresses without granting the profile scope.
 */
const PROVIDER_SCOPES: Record<ProviderId, string[]> = {
  google: ["openid", "email"],
  github: ["user:email"],
};

interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * A provider is configured only when it has both halves of its credential pair.
 * Half a pair is a deployment mid-setup, and advertising a button for it would
 * send a user to a handshake that cannot complete.
 */
function credentialsFor(provider: ProviderId, env: Env): ProviderCredentials | null {
  const pair =
    provider === "google"
      ? { clientId: env.OAUTH_GOOGLE_CLIENT_ID, clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET }
      : { clientId: env.OAUTH_GITHUB_CLIENT_ID, clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET };

  const clientId = pair.clientId?.trim();
  const clientSecret = pair.clientSecret?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The providers this deployment can actually offer, in the order the page shows
 * them. Empty is a legitimate state: a self-hoster who configures no OAuth app
 * still serves every document they already have.
 */
export function configuredProviders(env: Env): ProviderId[] {
  return PROVIDER_IDS.filter((provider) => credentialsFor(provider, env) !== null);
}

/** Whether approval can run at all, which is to say: is there a provider. */
export function approvalIsConfigured(env: Env): boolean {
  return configuredProviders(env).length > 0;
}

/**
 * The provider handshake, as the approval page needs it.
 *
 * An interface rather than two loose functions because arctic drives it over
 * the network through the global `fetch`, which a test cannot inject into.
 * Replacing the whole client keeps the tests off the network without pretending
 * to reimplement Google.
 */
export interface OAuthClient {
  /**
   * Where to send the browser to prove who it is.
   *
   * @param verifier the PKCE code verifier; Google carries its S256 challenge,
   *   GitHub has no PKCE support and ignores it, which is why the cookie's
   *   `state` is what stops a forged callback there
   */
  authorizationUrl(provider: ProviderId, redirectUri: string, state: string, verifier: string): URL;

  /**
   * Exchange the authorization code and return the address the provider
   * verified, or null when it refuses, fails, or names none it stands behind.
   */
  verifiedEmail(
    provider: ProviderId,
    redirectUri: string,
    code: string,
    verifier: string,
  ): Promise<string | null>;
}

/** GitHub rejects an API request with no user agent, so every call names us. */
const GITHUB_USER_AGENT = "OpenArtifacts";

const GITHUB_EMAILS_ENDPOINT = "https://api.github.com/user/emails";

/**
 * The real client. Throws only what arctic throws; the caller treats any
 * failure as a handshake that did not complete.
 */
export function arcticOAuthClient(env: Env): OAuthClient {
  const provider = (id: ProviderId, redirectUri: string) => {
    const credentials = credentialsFor(id, env);
    // Unreachable from the routes, which check `configuredProviders` first. It
    // is a throw rather than a silent null because a provider that lost its
    // credentials mid-handshake is a broken deployment, not a user error.
    if (credentials === null) throw new Error(`${id} is not configured`);
    return id === "google"
      ? new Google(credentials.clientId, credentials.clientSecret, redirectUri)
      : new GitHub(credentials.clientId, credentials.clientSecret, redirectUri);
  };

  return {
    authorizationUrl(id, redirectUri, state, verifier) {
      const client = provider(id, redirectUri);
      return client instanceof Google
        ? client.createAuthorizationURL(state, verifier, PROVIDER_SCOPES.google)
        : client.createAuthorizationURL(state, PROVIDER_SCOPES.github);
    },

    async verifiedEmail(id, redirectUri, code, verifier) {
      const client = provider(id, redirectUri);

      if (client instanceof Google) {
        const tokens = await client.validateAuthorizationCode(code, verifier);
        // The id token came straight from Google's token endpoint over TLS on
        // this connection, so its signature adds nothing here — the thing a
        // signature would prove is already proved by where the bytes came from.
        return googleVerifiedEmail(decodeIdToken(tokens.idToken()));
      }

      const tokens = await client.validateAuthorizationCode(code);
      const response = await fetch(GITHUB_EMAILS_ENDPOINT, {
        headers: {
          authorization: `Bearer ${tokens.accessToken()}`,
          accept: "application/vnd.github+json",
          "user-agent": GITHUB_USER_AGENT,
        },
      });
      if (!response.ok) return null;
      return githubVerifiedEmail(await response.json());
    },
  };
}

/**
 * The address out of a Google id token, or null unless Google says it verified
 * it.
 *
 * `email_verified` is the load-bearing field, not `email`: a Google Workspace
 * administrator can put any address on an account, and only this flag says the
 * ownership was actually established. Exported so the guard is tested directly
 * rather than through a network handshake.
 *
 * Returned as Google wrote it. Folding it to the form accounts are unique on is
 * the approval page's job, in one place, so a provider added later cannot
 * quietly skip it and mint a second account for one person.
 */
export function googleVerifiedEmail(claims: unknown): string | null {
  if (typeof claims !== "object" || claims === null) return null;
  const { email, email_verified: verified } = claims as Record<string, unknown>;
  if (verified !== true) return null;
  return typeof email === "string" ? email : null;
}

/**
 * The primary verified address out of GitHub's `/user/emails`, or null when
 * there is none.
 *
 * Primary *and* verified, not either: GitHub lets an account hold several
 * addresses, some added and never confirmed, and an account here is keyed by
 * one address. Taking any verified address would make which account someone
 * lands on depend on the order GitHub happened to list them in.
 */
export function githubVerifiedEmail(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;

  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const { email, primary, verified } = entry as Record<string, unknown>;
    if (primary !== true || verified !== true) continue;
    if (typeof email !== "string") continue;
    return email;
  }
  return null;
}

/**
 * Fold an address to the form `accounts.email` is unique on, or null when it is
 * not an address at all.
 *
 * Lowercasing is what makes approving with Google and then GitHub reach one
 * account: the local part of an address is case-sensitive by the letter of RFC
 * 5321, and by the practice of every mailbox provider these two hand out, it is
 * not. Two rows for one person would be two shelves of documents that can never
 * be reunited, which is the worse of the two failures by a long way.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || /\s/.test(email)) return null;

  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  return email;
}
