/**
 * The device flow: how a terminal with no credential gets one.
 *
 * An agent's CLI has nothing to publish with, and the one thing it must never
 * do is ask the person to paste a secret — a secret pasted into an agent's
 * conversation is a secret in a transcript, a log and a context window. So it
 * asks for a code instead, prints a url, and waits. The person approves in a
 * browser on any device, and the terminal's next poll collects a token nobody
 * ever read aloud.
 *
 * RFC 8628 shaped, not RFC 8628 wire compatible. The two endpoints, the two
 * codes, the polling interval and the four poll conditions are the standard's;
 * the request bodies are JSON like the rest of this API rather than form
 * encoded, and a failure carries this API's `{error: {code, message}}` envelope
 * with the RFC's code names inside it. A client written against the standard
 * recognises everything that matters, and a client written against
 * `docs/http-api.md` still has exactly one error shape to parse.
 *
 * **Neither endpoint authenticates**, which is the whole point — the caller has
 * no credential yet — so both are outside `/api/v1`, where every request
 * carries one. The mint is rate limited per client address instead, because an
 * endpoint that produces approval urls is an endpoint someone would otherwise
 * use to send people approval urls.
 *
 * That limit is a Workers rate limiter binding rather than a counter in D1. A
 * counter in a row costs a write for every attempt including the refused ones,
 * so under sustained abuse the limiter would be what exhausts a self-hoster's
 * daily write budget — the endpoint's own defence paying the attacker's bill.
 */
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_MINT_PERIOD_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  MAX_TOKENS_PER_ACCOUNT,
  type Env,
} from "./config.js";
import { APPROVAL_PREFIX, USER_CODE_PARAM } from "./approval/handler.js";
import { collectDeviceToken, findPolledDeviceCode, insertDeviceCode, sweepExpired } from "./db.js";
import { errorResponse } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { newApiToken, newDeviceCode, newTokenId, newUserCode } from "./ids.js";
import { withinClientLimit, withinLimit } from "./limits.js";
import { readBodyWithin } from "./quota.js";

/** Path prefix of the device surface, used by the router on the API host. */
export const DEVICE_PREFIX = "/device";

/**
 * Ceiling on a request body here.
 *
 * Both endpoints are unauthenticated, so without a bound anyone who can reach
 * the API host could make the Worker hold an arbitrary body. A device code and
 * a label are a few hundred bytes; a kilobyte is room neither request will grow
 * into. Enforced on bytes actually read rather than on `Content-Length`, for
 * the reason the approval page's form reader gives: the header is the client's
 * own assertion and a body is free to under-declare itself.
 */
const MAX_DEVICE_BODY_BYTES = 1024;

/**
 * Longest label kept from a mint request.
 *
 * It is client-supplied text that a person reads on the approval page while
 * deciding whether to approve, so it has to fit on that page and stay one
 * glance long. Anything past this is cut rather than refused: a terminal with a
 * verbose idea of its own name should still be able to sign in.
 */
const MAX_LABEL_LENGTH = 80;

/**
 * Attempts at drawing an unused user code before giving up.
 *
 * Three, because a collision at this alphabet size against the codes alive at
 * once is already unlikely and three independent draws make it absurd. Looping
 * without a bound would turn a table the sweep has stopped clearing into a
 * request that never returns.
 */
const USER_CODE_ATTEMPTS = 3;

/**
 * The only content type either endpoint accepts, and the reason it is required
 * rather than merely expected.
 *
 * Both endpoints are unauthenticated `POST`s, so a page anybody visits can aim
 * a cross-origin request at them. `application/json` is not one of the three
 * types a form can send, so a browser has to preflight it — and this host
 * answers no `Access-Control-Allow-Origin`, so the preflight fails and the
 * request never leaves the browser. A form-encoded or `text/plain` body, by
 * contrast, is a simple request that arrives whether the visitor meant it or
 * not. Refusing those before the mint touches its rate limiter is what stops a
 * hostile page spending a visitor's sign-in allowance for them
 * (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3927574066).
 *
 * Required even when the body is empty, since a `fetch` with no body and no
 * headers is a simple request too.
 */
const JSON_CONTENT_TYPE = "application/json";

/**
 * Everything a terminal could hide in a label that could alter the question a
 * person sees: terminal controls, and Unicode bidirectional controls that HTML
 * escaping does not neutralize.
 */
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;
const BIDI_CONTROL_CHARACTERS = /\p{Bidi_Control}/gu;

export interface DeviceDeps {
  now?: () => number;
  /**
   * Injected by tests that need a limiter a deployment has not declared, or a
   * verdict they choose. Production always reads `env.DEVICE_CODE_LIMITER`.
   */
  mintLimiter?: RateLimit;
  /** Injected poll limiter; production reads `env.DEVICE_POLL_LIMITER`. */
  pollLimiter?: RateLimit;
}

/**
 * Two routes, and one method each:
 *
 * ```
 * POST /device/code    mint a device code and the user code a person approves
 * POST /device/token   collect the token that approval earned
 * ```
 *
 * `POST` for both because both write, and because a `GET` that minted a code
 * would mint one every time a link was followed.
 */
export async function handleDevice(
  request: Request,
  url: URL,
  env: Env,
  deps: DeviceDeps = {},
): Promise<Response> {
  const [route, ...extra] = url.pathname.slice(DEVICE_PREFIX.length).split("/").filter(Boolean);

  if (extra.length === 0 && request.method === "POST") {
    // `return await`: see the note on the router's catch in index.ts.
    if (route === "code") return await mint(request, url, env, deps);
    if (route === "token") return await poll(request, env, deps);
  }
  return errorResponse("not_found", `No device route for ${url.pathname}`);
}

/** One mint, as RFC 8628 §3.2 names its fields. */
interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  /** Where to send the person when their terminal cannot open a browser. */
  verification_uri: string;
  /** The same page with the code already filled in, which is what a CLI prints. */
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * `POST /device/code` — mint a code for a terminal that has no credential.
 *
 * The order is deliberate, and the first half of it is a security property
 * rather than tidiness. **Nothing a browser can send cross-site reaches the
 * rate limiter**: the content type and the body shape are checked first, so a
 * page a victim happens to visit cannot burn their sign-in allowance by firing
 * simple `POST`s at this endpoint. `JSON_CONTENT_TYPE` says why that check is
 * the one that closes it.
 *
 * The limiter comes next, so a refused caller still touches no storage. The
 * sweep comes after that, because a user code cannot be reused until the row
 * holding it is gone and minting is the only thing that needs one free.
 *
 * A deployment that declares no limiter mints freely. That is a supported
 * deployment, not a hole to close: see `Env.DEVICE_CODE_LIMITER`.
 */
async function mint(
  request: Request,
  url: URL,
  env: Env,
  deps: DeviceDeps,
): Promise<Response> {
  const now = (deps.now ?? Date.now)();

  const body = await readJsonBody(request);
  if (body === null) {
    return badRequest("The request body must be JSON, sent as `content-type: application/json`.");
  }

  const label = readDeviceLabel(body.label);
  if (label === undefined) return badRequest("`label` must be a string.");

  const limiter = deps.mintLimiter ?? env.DEVICE_CODE_LIMITER;
  if (!(await withinClientLimit(limiter, request))) {
    // `Retry-After` is the limiter's whole window, because the binding reports
    // a verdict and nothing else: no reset time, no remaining count. Telling
    // the caller to wait the full period is the only honest number available,
    // and it is never an underestimate.
    return errorResponse(
      "quota_exceeded",
      "Too many sign-in codes from this address. Try again shortly.",
      { "retry-after": String(DEVICE_MINT_PERIOD_SECONDS), "cache-control": "no-store" },
    );
  }

  await sweepExpired(env.DB, now);

  const deviceCode = newDeviceCode();
  const deviceCodeHash = await sha256Hex(deviceCode);
  const expiresAt = now + DEVICE_CODE_TTL_MS;

  const userCode = await claimUserCode(env.DB, {
    device_code_hash: deviceCodeHash,
    label,
    expires_at: expiresAt,
    created_at: now,
  });
  if (userCode === null) {
    return errorResponse("internal", "Could not start a sign-in. Please try again.");
  }

  const verificationUri = `${url.origin}${APPROVAL_PREFIX}`;
  const authorization: DeviceAuthorization = {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?${USER_CODE_PARAM}=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  };
  // `no-store` on both routes, as RFC 6749 §5.1 requires of anything carrying a
  // credential. The device code is one, even though it is not the token.
  return Response.json(authorization, { headers: { "cache-control": "no-store" } });
}

/** The token a collected approval hands back, once and only once. */
interface IssuedToken {
  /** RFC 6749 §5.1's name for it. This is the value the CLI stores on disk. */
  access_token: string;
  token_type: "Bearer";
  /** The public name of the token, which `GET /api/v1/tokens` also reports. */
  token_id: string;
  /** What the mint request called this machine, so the CLI can confirm it. */
  label: string | null;
}

/**
 * `POST /device/token` — ask whether the code has been approved, and collect
 * the token if it has.
 *
 * Every refusal is one of RFC 8628 §3.5's four conditions, and which one a
 * caller gets is deliberately not a way to learn anything: an unknown device
 * code answers exactly like an expired one, because the alternative is an
 * endpoint that confirms which random strings are real.
 *
 * The interval is enforced by a Workers rate limiter keyed by the device-code
 * hash. Pending polls are therefore reads, never timestamp writes, while the
 * transactional collection below still makes token issue exclusive.
 */
async function poll(request: Request, env: Env, deps: DeviceDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();

  const body = await readJsonBody(request);
  if (body === null) {
    return badRequest("The request body must be JSON, sent as `content-type: application/json`.");
  }

  const deviceCode = body.device_code;
  if (typeof deviceCode !== "string" || deviceCode === "") {
    return badRequest("`device_code` must be the device code from POST /device/code.");
  }

  const deviceCodeHash = await sha256Hex(deviceCode);
  const pollLimiter = deps.pollLimiter ?? env.DEVICE_POLL_LIMITER;
  if (!(await withinLimit(pollLimiter, deviceCodeHash))) {
    return device(
      "slow_down",
      `Polling too fast. Wait ${DEVICE_POLL_INTERVAL_SECONDS} seconds between requests.`,
    );
  }

  const code = await findPolledDeviceCode(env.DB, deviceCodeHash);

  // Unknown, already collected, or swept — one answer for all three. A
  // collected code is deleted rather than marked spent, so a replay lands here.
  if (code === null || code.expires_at <= now) {
    return device("expired_token", "That sign-in has expired. Start again.");
  }
  if (code.denied_at !== null) {
    return device("access_denied", "That sign-in was refused in the browser.");
  }
  if (code.approved_at === null) {
    return device("authorization_pending", "Waiting for the sign-in to be approved.");
  }

  const token = newApiToken();
  const tokenId = newTokenId();
  const issued = await collectDeviceToken(
    env.DB,
    deviceCodeHash,
    { id: tokenId, token_hash: await sha256Hex(token), created_at: now },
    MAX_TOKENS_PER_ACCOUNT,
  );

  // Null only when another poll collected between the read above and this
  // write. The code is spent, and the terminal that lost has nothing left to
  // wait for. An account at its ceiling is not a refusal: the collection
  // evicts that account's least recently used token instead.
  if (issued === null) {
    return device("expired_token", "That sign-in has expired. Start again.");
  }

  const collected: IssuedToken = {
    access_token: token,
    token_type: "Bearer",
    token_id: tokenId,
    label: issued.label,
  };
  return Response.json(collected, { headers: { "cache-control": "no-store" } });
}

/** A poll condition, in this API's envelope and with RFC 8628's name inside it. */
function device(
  code: "authorization_pending" | "slow_down" | "expired_token" | "access_denied",
  message: string,
): Response {
  return errorResponse(code, message, { "cache-control": "no-store" });
}

function badRequest(message: string): Response {
  return errorResponse("bad_request", message, { "cache-control": "no-store" });
}

/**
 * The parsed JSON body, or null when the request is not one a client of this
 * API could have sent.
 *
 * The content type is checked here rather than at each caller so that neither
 * endpoint can be reached by a request a browser would send without a
 * preflight — see `JSON_CONTENT_TYPE`. It is required even of a bodyless
 * request for that reason, and only for that reason.
 *
 * An empty body is then an empty object rather than an error: the mint requires
 * no field, and a client that sends no label should not have to send `{}` to
 * say so.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== JSON_CONTENT_TYPE) return null;

  const bytes = await readBodyWithin(request, MAX_DEVICE_BODY_BYTES);
  if (bytes === null) return null;
  if (bytes.byteLength === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * The label to store, or `undefined` when the caller sent something that is not
 * one.
 *
 * Control characters go before anything else, because this string is rendered
 * on the approval page and printed in CLI output. Newlines and escape sequences
 * can draw over the question; Unicode bidi controls can reorder it even after
 * HTML escaping. Natural RTL letters remain intact and the page isolates them
 * when rendered. Blank after cleaning means the caller effectively sent none.
 *
 * @param raw the `label` field exactly as it arrived, which may be anything
 */
export function readDeviceLabel(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;

  const cleaned = raw
    .replace(TERMINAL_CONTROL_CHARACTERS, " ")
    .replace(BIDI_CONTROL_CHARACTERS, "")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned === "" ? null : cleaned;
}

/**
 * Insert the code under a freshly drawn user code, redrawing on the one thing
 * that can refuse the insert: a code still in use.
 */
async function claimUserCode(
  db: D1Database,
  code: { device_code_hash: string; label: string | null; expires_at: number; created_at: number },
): Promise<string | null> {
  for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
    const userCode = newUserCode();
    if (await insertDeviceCode(db, { user_code: userCode, ...code })) return userCode;
  }
  return null;
}
