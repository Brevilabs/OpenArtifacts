/**
 * Product analytics: four document outcomes, delivered straight to PostHog.
 *
 * The module exists to make one property structural rather than a review habit.
 * What leaves this Worker is decided *here*, from a closed union of four event
 * shapes, and never by a caller: `properties` is assembled below out of those
 * fields alone, and nothing in the interface accepts a property bag, a
 * `Request`, a title or a url. A call site that wanted to attach one
 * would have nowhere to put it, which is a stronger guarantee than an allowlist
 * checked at send time — that one keeps working right up until somebody adds a
 * key to it.
 *
 * Delivery is best effort on purpose. An event is scheduled on `ctx.waitUntil`
 * once the response is already decided, it is never retried, and a PostHog
 * outage costs a lost count rather than a failed publish. That is also why this
 * is a direct POST rather than a queue: the questions these events answer are
 * "roughly how many" questions, and buying exactly-once delivery for them would
 * put a queue, a consumer and a replay story in the path of every push. The
 * consequence is stated wherever the numbers are read — totals are observed
 * usage since instrumentation began, not exact all-time counts.
 */
import type { Env } from "./config.js";
import { withinLimit } from "./limits.js";
import { sha256Hex } from "./hash.js";

/** PostHog's single-event capture endpoint. */
const CAPTURE_PATH = "/i/v0/e/";

/**
 * Where events go when `POSTHOG_HOST` is not set. Delivery is gated on the
 * ingest key alone, so setting the secret is enough to deliver.
 */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * What an event is labelled when `ANALYTICS_ENVIRONMENT` is not set.
 *
 * Unset means development, never production. Every business query filters on
 * `environment = "production"`, so the safe default is the one that leaves a
 * stray event out of the totals rather than the one that folds a laptop's
 * synthetic push into them.
 */
const DEFAULT_ENVIRONMENT = "development";

/**
 * How long one delivery may take before it is abandoned.
 *
 * Two seconds is far above a healthy capture POST, which is a small body to an
 * edge endpoint and answers in tens of milliseconds, and far below the point
 * where a slow PostHog would start to matter. The number is here at all because
 * `fetch` has no default timeout: without it, an intake that accepts a
 * connection and then stops talking would hold a `waitUntil` open for every
 * push and view until the runtime tore the request context down. Bounding it
 * turns that outage into a handful of dropped events, which is exactly what
 * best-effort delivery already promises.
 */
export const ANALYTICS_TIMEOUT_MS = 2000;

/**
 * Longest user agent a view event carries. Real browser strings are a few
 * hundred characters; the header is reader-controlled, so it is capped.
 */
export const MAX_USER_AGENT_LENGTH = 512;

/**
 * The four outcomes worth counting, and the only things that can be recorded.
 *
 * A view event has no `ownerId` field to fill in, so a reader cannot be turned
 * into an account; the three publication events do have one, because the actor
 * there is an account this Worker already resolved from a credential it
 * validated. The one thing a view carries about its reader is the user agent.
 */
export type DocumentEvent =
  | {
      name: "document_published" | "document_updated" | "document_unshared";
      /** The doc the outcome is about. Hashed to an opaque key; never sent raw. */
      docId: string;
      /** When the outcome happened, epoch ms. */
      atMs: number;
      /** The account that performed it — always derived, never request input. */
      ownerId: string;
    }
  | {
      name: "document_viewed";
      docId: string;
      atMs: number;
      /** The reader's `User-Agent` header, or null when absent. */
      userAgent: string | null;
    };

export interface AnalyticsSink {
  /** Fire and forget. Never throws, never returns a promise a handler awaits. */
  record(event: DocumentEvent): void;
}

/**
 * Records nothing.
 *
 * It is what `analyticsSink` returns when no ingest key is configured, and what
 * a test that is not about analytics passes so the surrounding behaviour is
 * unchanged. Making the absence of analytics a sink rather than an optional
 * parameter is what keeps every handler's body free of a null check before it
 * records, and it is why a deployment with no secret costs nothing at all
 * rather than a branch per outcome.
 */
export const NO_ANALYTICS: AnalyticsSink = {
  record() {},
};

/**
 * Hashed in ahead of the doc id, so this digest can never collide with another
 * use of the same value — a doc id that also became, say, a cache key would
 * otherwise produce the same bytes in two systems that mean different things by
 * them.
 */
const DOCUMENT_KEY_DOMAIN = "openartifacts/doc-analytics/v1\n";

/** Hex characters kept from the digest: the first 16 bytes, two characters each. */
const DOCUMENT_KEY_HEX_LENGTH = 32;

/**
 * The opaque per-document key every event carries.
 *
 * Same input, same key, forever. That is the whole point: one document's
 * publication, its updates, its views and its withdrawal share a key, so
 * PostHog can count distinct pages without ever holding a doc id — and a doc id
 * is a capability, since whoever holds one holds the document.
 *
 * Unsalted deliberately. A salt would have to survive every future deploy and
 * every rebuild to keep the one property the key exists for, so it is a
 * rotation hazard standing against stability rather than a defence. It buys
 * little here anyway: a doc id is 80 bits of CSPRNG, so there is no feasible
 * preimage for anyone who was not already given the link, and anyone who *was*
 * given the link can already read the document.
 *
 * Truncated to 128 bits because what this key needs is collision resistance
 * between documents, not the full digest. Distinct-page counts are wrong the
 * moment two documents share a key, and 128 bits puts that far beyond the
 * number of documents this service will ever hold; the other 32 characters
 * would be wire weight on every event for nothing.
 */
export async function documentAnalyticsKey(docId: string): Promise<string> {
  const digest = await sha256Hex(`${DOCUMENT_KEY_DOMAIN}${docId}`);
  return `doc_${digest.slice(0, DOCUMENT_KEY_HEX_LENGTH)}`;
}

/**
 * The entire wire format, built from the typed event and nothing else.
 *
 * `distinct_id` is the one field that changes shape between the two kinds of
 * event, and it is the reason the union exists. A publication is attributed to
 * the account that performed it, because "how many distinct publishers" is a
 * question worth asking of an account we already identified. A view is
 * attributed to the document, because the alternative — any reader-derived
 * value — would be inventing an identifier for someone who never asked for one.
 *
 * Its placement is the endpoint's contract rather than a style choice. `/i/v0/e/`
 * requires `api_key`, `event` and `distinct_id` as top-level fields and treats
 * `properties` as optional, so the identifier belongs at the top and `properties`
 * carries only the allowlist below. The nested `properties.distinct_id` spelling
 * belongs to `/batch/`, where every element of the array has to name its own
 * subject; borrowing it here would move a field this endpoint documents as
 * required out of the place it is required in, and an intake stub that accepts
 * any JSON would keep the tests green all the way to an ingestion that drops the
 * events.
 *
 * `$process_person_profile` follows from that. It is `false` for a view so
 * PostHog stores the event without ever materialising a person behind it, and
 * `true` for the three publication events, where the person is an account that
 * already exists here.
 *
 * `$geoip_disable` because PostHog would otherwise geolocate the address the
 * capture came from, which is this Worker's egress and not anyone's location.
 *
 * A view's user agent goes in `$raw_user_agent`, the property PostHog's bot
 * classification and user-agent parsing read for server-side events.
 */
function capturePayload(
  apiKey: string,
  environment: string,
  event: DocumentEvent,
  documentKey: string,
  uuid: string,
): string {
  const viewed = event.name === "document_viewed";
  return JSON.stringify({
    api_key: apiKey,
    event: event.name,
    distinct_id: viewed ? documentKey : event.ownerId,
    timestamp: new Date(event.atMs).toISOString(),
    uuid,
    properties: {
      service: "openartifacts",
      environment,
      document_key: documentKey,
      $process_person_profile: !viewed,
      $geoip_disable: true,
      ...(viewed && event.userAgent
        ? { $raw_user_agent: event.userAgent.slice(0, MAX_USER_AGENT_LENGTH) }
        : {}),
    },
  });
}

/**
 * Everything a failed delivery is allowed to say.
 *
 * The event name and a status, and deliberately nothing else. The payload would
 * carry the document key, the owner and the timestamp into a log that is read
 * far more casually than an event store; the doc id is a capability; and the
 * response body is written by a third party, so quoting it would let PostHog
 * decide what appears in our logs. A count of failures by event name is what
 * operating this actually needs.
 */
function deliveryFailed(event: DocumentEvent, status: number | null): void {
  console.warn("analytics delivery failed", { event: event.name, status });
}

/** One POST. Resolves whether PostHog accepted it or not; rejects only on the network. */
async function deliver(
  apiKey: string,
  /** Already stripped of a trailing slash, so the path below appends cleanly. */
  host: string,
  environment: string,
  event: DocumentEvent,
  documentKey: string,
  uuid: string,
): Promise<void> {
  const response = await fetch(`${host}${CAPTURE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: capturePayload(apiKey, environment, event, documentKey, uuid),
    signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
    // The body carries the ingest key, so a followed redirect is a credential
    // leak waiting for a misconfigured or hijacked `POSTHOG_HOST`: `fetch` would
    // re-POST the whole payload, key included, to wherever the 307 pointed.
    // `manual` hands the 3xx back instead of chasing it, and since a 3xx is not
    // `ok` it falls into the failure below and is logged with its status. The
    // credential goes to exactly one host, the one that was configured.
    //
    // `error` is the obvious way to say this and it cannot be used: the Workers
    // runtime rejects that value outright — "won't be implemented since it does
    // not make sense at the edge; use manual and check the response status
    // code" — and the `TypeError` it throws is indistinguishable, from the
    // outside, from an intake that is simply down.
    redirect: "manual",
  });

  if (!response.ok) deliveryFailed(event, response.status);
}

/**
 * Whether a view may be sent, against its document's `VIEW_EVENT_LIMITER`
 * allowance. Checked inside `waitUntil`, after the reader has their page, so
 * the limiter can never slow or fail a read.
 *
 * An undeclared binding or a failing limiter sends nothing: this bound is what
 * stands between an anonymous public url and a metered bill. The reasoning,
 * and why the bucket is per document, is in docs/analytics.md under "Cost".
 */
async function viewWithinAllowance(
  limiter: RateLimit | undefined,
  documentKey: string,
): Promise<boolean> {
  if (limiter === undefined) return false;
  try {
    return await withinLimit(limiter, documentKey);
  } catch {
    return false;
  }
}

/**
 * The production sink.
 *
 * Configuration is read once, when the sink is built, and delivery is gated on
 * the ingest key alone — so a deployment that sets no secret, which is every
 * local checkout and the whole test suite, gets `NO_ANALYTICS` and makes no
 * request at all. Gating on the key rather than on an environment name is what
 * makes "silent unless configured" the default instead of a thing an operator
 * has to remember to turn off.
 */
export function analyticsSink(env: Env, ctx: ExecutionContext): AnalyticsSink {
  const apiKey = env.POSTHOG_PROJECT_API_KEY?.trim();
  if (!apiKey) return NO_ANALYTICS;

  const host = (env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  const environment = env.ANALYTICS_ENVIRONMENT?.trim() || DEFAULT_ENVIRONMENT;
  const viewLimiter = env.VIEW_EVENT_LIMITER;

  const send = async (event: DocumentEvent, uuid: string): Promise<void> => {
    const documentKey = await documentAnalyticsKey(event.docId);
    if (event.name === "document_viewed" && !(await viewWithinAllowance(viewLimiter, documentKey))) {
      return;
    }
    await deliver(apiKey, host, environment, event, documentKey, uuid);
  };

  return {
    record(event) {
      // Minted per `record` call rather than per request, so one event has one
      // identity. If a bounded retry is ever added it belongs inside `deliver`,
      // below this line, where it would resend the same `uuid` and the same
      // `timestamp` and PostHog would deduplicate it rather than count twice.
      const uuid = crypto.randomUUID();
      // The `catch` is the contract, not a precaution: `record` promises never
      // to throw and never to hand a handler a promise, so a network failure
      // has to end here. `waitUntil` would otherwise report it as an unhandled
      // rejection against a request that has already answered correctly.
      ctx.waitUntil(
        send(event, uuid).catch(() => {
          deliveryFailed(event, null);
        }),
      );
    },
  };
}
