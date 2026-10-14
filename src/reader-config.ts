/**
 * Whether this deployment can do private sharing at all: the one predicate every
 * private-sharing gate asks, in the one place it is defined.
 *
 * A leaf module on purpose. It imports configuration and nothing that serves
 * or renders, so the router, the API routes, the label host and the reader
 * pages can all depend on it without a cycle, and none of them keeps a private
 * copy of the rule that could drift from the others.
 */
import { configuredProviders } from "./approval/providers.js";
import type { Env } from "./config.js";
import { emailConfigured } from "./email.js";

const MIN_SECRET_LENGTH = 32;

/**
 * The signing secret, or null when private sharing is not set up here. Every
 * caller treats null as "nothing private can be opened", never as "unsigned".
 */
export function readerSecret(env: Env): string | null {
  const secret = env.READER_SESSION_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/**
 * Reader sign-in is configured when all of these hold: a valid signing secret;
 * both hosts, because `/open` and the grant it mints need the API host and the
 * label hosts hang off the serving host; and at least one way to sign in,
 * Google or GitHub (both halves of a credential pair) or emailed codes.
 *
 * When it is false the server behaves exactly like a Worker that predates
 * private sharing. `POST /api/v1/private-docs`, every `…/access` route,
 * `…/open`, `/open/*`, `/share/*`, `/signin/*` and every label host answer
 * `404`, and served pages carry no Manage link. No half-configured state
 * exists, which is why the gates are all one call to this function.
 *
 * Documents already stored as invited-only are not made public by this: the
 * apex still sends them to `/open`, which answers `404`. Removing the secret
 * takes them offline; it never publishes them.
 */
export function readerSignInConfigured(env: Env): boolean {
  return (
    readerSecret(env) !== null &&
    Boolean(env.SERVING_HOST?.trim()) &&
    Boolean(env.API_HOST?.trim()) &&
    (configuredProviders(env).length > 0 || emailConfigured(env))
  );
}
