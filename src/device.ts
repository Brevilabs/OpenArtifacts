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
 */
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_MINT_WINDOW_MS,
  DEVICE_POLL_INTERVAL_SECONDS,
  MAX_DEVICE_MINTS_PER_WINDOW,
  MIN_DEVICE_POLL_GAP_MS,
  type Env,
} from "./config.js";
import { APPROVAL_PREFIX, USER_CODE_PARAM } from "./approval/handler.js";
import {
  claimDeviceMint,
  collectDeviceToken,
  findPolledDeviceCode,
  insertDeviceCode,
  recordDevicePoll,
  sweepExpired,
} from "./db.js";
import { errorResponse } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { newApiToken, newDeviceCode, newTokenId, newUserCode } from "./ids.js";
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

/** Bucket a request with no client address falls into. */
const ANONYMOUS_CLIENT = "anonymous";

/**
 * Everything a terminal could hide in a label that a terminal would then act
 * on: newlines, and the escape that starts an ANSI sequence.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

export interface DeviceDeps {
  now?: () => number;
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
 * The order is deliberate. The rate limit is claimed before anything else, so a
 * refused caller costs one write and never reaches the sweep or a draw; the
 * sweep runs next, because a user code cannot be reused until the row holding
 * it is gone and minting is the only thing that needs one free.
 */
async function mint(
  request: Request,
  url: URL,
  env: Env,
  deps: DeviceDeps,
): Promise<Response> {
  const now = (deps.now ?? Date.now)();

  const client = await deviceClientBucket(request);
  const windowStart = Math.floor(now / DEVICE_MINT_WINDOW_MS) * DEVICE_MINT_WINDOW_MS;
  if (!(await claimDeviceMint(env.DB, client, windowStart, MAX_DEVICE_MINTS_PER_WINDOW))) {
    const retryAfter = Math.ceil((windowStart + DEVICE_MINT_WINDOW_MS - now) / 1000);
    return errorResponse(
      "quota_exceeded",
      "Too many sign-in codes from this address. Try again shortly.",
      { "retry-after": String(retryAfter), "cache-control": "no-store" },
    );
  }

  const body = await readJsonBody(request);
  if (body === null) return badRequest("The request body must be a JSON object.");

  const label = readDeviceLabel(body.label);
  if (label === undefined) return badRequest("`label` must be a string.");

  await sweepExpired(env.DB, now, DEVICE_MINT_WINDOW_MS);

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
 */
async function poll(request: Request, env: Env, deps: DeviceDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();

  const body = await readJsonBody(request);
  if (body === null) return badRequest("The request body must be a JSON object.");

  const deviceCode = body.device_code;
  if (typeof deviceCode !== "string" || deviceCode === "") {
    return badRequest("`device_code` must be the device code from POST /device/code.");
  }

  const deviceCodeHash = await sha256Hex(deviceCode);
  const code = await findPolledDeviceCode(env.DB, deviceCodeHash);
  // Unknown, already collected, or swept — one answer for all three. A
  // collected code is deleted rather than marked spent, so a replay lands here.
  if (code === null) return device("expired_token", "That sign-in has expired. Start again.");

  if (code.last_polled_at !== null && now - code.last_polled_at < MIN_DEVICE_POLL_GAP_MS) {
    return device(
      "slow_down",
      `Polling too fast. Wait ${DEVICE_POLL_INTERVAL_SECONDS} seconds between requests.`,
    );
  }
  if (code.expires_at <= now) {
    return device("expired_token", "That sign-in has expired. Start again.");
  }
  if (code.denied_at !== null) {
    return device("access_denied", "That sign-in was refused in the browser.");
  }

  if (code.approved_at === null) {
    // Only the waiting path records the poll. The collecting one is about to
    // delete this row, so writing to it first would be a write for nobody.
    await recordDevicePoll(env.DB, deviceCodeHash, now);
    return device("authorization_pending", "Waiting for the sign-in to be approved.");
  }

  const token = newApiToken();
  const tokenId = newTokenId();
  const issued = await collectDeviceToken(env.DB, deviceCodeHash, {
    id: tokenId,
    token_hash: await sha256Hex(token),
    created_at: now,
  });
  // Null only when another poll collected between the read above and this
  // write. The code is gone either way, and the terminal that lost has nothing
  // to wait for.
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
 * The parsed JSON body, or null when it is not an object.
 *
 * An absent or empty body is an empty object rather than an error: the mint has
 * nothing it requires, and a CLI that sends no label should not have to send
 * `{}` to say so.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
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
 * on the approval page and printed in CLI output: a newline or an escape
 * sequence in it would let a terminal's chosen name draw over the question the
 * person is being asked. Blank after that means the caller effectively sent
 * none, and the page falls back to its own words.
 *
 * @param raw the `label` field exactly as it arrived, which may be anything
 */
export function readDeviceLabel(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;

  const cleaned = raw.replace(CONTROL_CHARACTERS, " ").trim().slice(0, MAX_LABEL_LENGTH);
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

/**
 * The bucket a mint is counted against.
 *
 * The client's address, hashed. Hashed because it is a counter key rather than
 * a record of who visited: nothing here ever needs to read an address back, and
 * a table of them is a table someone would eventually be right to ask about.
 * Where the platform reports no address — local development, and the tests —
 * every caller shares one bucket, which is the safe direction for a limit.
 */
async function deviceClientBucket(request: Request): Promise<string> {
  const address = request.headers.get("cf-connecting-ip")?.trim();
  return await sha256Hex(address === undefined || address === "" ? ANONYMOUS_CLIENT : address);
}
