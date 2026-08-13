import type { Env } from "./config.js";

const POSTHOG_CAPTURE_PATH = "/i/v0/e/";

export type PublishOperation = "create" | "update";

type SymposiumEvent =
  | { event: "symposium_publish"; operation: PublishOperation }
  | { event: "symposium_unshare" };

/**
 * Send one deliberately small event to PostHog.
 *
 * The publisher id is the account id authentication already resolved for
 * ownership. Document ids and request data are not accepted by this interface,
 * which keeps accidental content, urls, license keys, and reader data out of
 * the payload by construction.
 */
async function capture(env: Env, owner: string, event: SymposiumEvent): Promise<void> {
  if (!env.POSTHOG_PROJECT_API_KEY || !env.POSTHOG_HOST || !env.ENVIRONMENT) return;

  const properties: Record<string, string | boolean> = {
    service: "symposium",
    environment: env.ENVIRONMENT,
    // Keep the shared account id available for event analysis without creating
    // or updating a PostHog person profile.
    $process_person_profile: false,
  };
  if (event.event === "symposium_publish") properties.operation = event.operation;

  const response = await fetch(new URL(POSTHOG_CAPTURE_PATH, env.POSTHOG_HOST), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.POSTHOG_PROJECT_API_KEY,
      event: event.event,
      distinct_id: owner,
      properties,
    }),
  });

  if (!response.ok) {
    // Deliberately omit owner and response body: neither helps operate the
    // publisher API, and the body is controlled by a third party.
    throw new Error(`PostHog capture returned HTTP ${response.status}`);
  }
}

export function capturePublish(
  env: Env,
  owner: string,
  operation: PublishOperation,
): Promise<void> {
  return capture(env, owner, { event: "symposium_publish", operation });
}

export function captureUnshare(env: Env, owner: string): Promise<void> {
  return capture(env, owner, { event: "symposium_unshare" });
}

/**
 * Analytics is a side effect of a completed operation, never part of it.
 * `waitUntil` gives the request time to deliver the event after its response is
 * ready; this catch guarantees a network or PostHog failure cannot reject the
 * Worker request.
 */
export function scheduleCapture(ctx: ExecutionContext, delivery: Promise<void>): void {
  ctx.waitUntil(
    delivery.catch((error: unknown) => {
      console.warn("PostHog capture failed", error);
    }),
  );
}
