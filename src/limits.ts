/**
 * The per-client limits on the three routes that answer without a credential.
 *
 * Minting a device code, looking one up on the approval page, and starting a
 * handshake all have to work for somebody who has nothing to present, so the
 * caller's address is the only thing there is to count against. This module is
 * how that address becomes a limiter key, and it lives apart from both callers
 * because `src/device.ts` and `src/approval/handler.ts` already point at each
 * other and neither should import the other for this.
 *
 * A limit keyed on an address is only as good as the requests that reach it. A
 * page anybody visits can make that visitor's browser send requests from their
 * address, so anything counted has to refuse those first, or the limit becomes
 * a way to spend somebody else's allowance rather than a way to bound their
 * own. `isTopLevelRequest` is that gate for the routes a browser reaches with a
 * `GET`; the device endpoints use a content type instead, since they take a
 * body and a browser cannot send that one cross-site without a preflight.
 */
import { sha256Hex } from "./hash.js";

/** Bucket a request with no client address falls into. */
const ANONYMOUS_CLIENT = "anonymous";

/**
 * Hex characters kept from the hashed address.
 *
 * 128 bits, which is far more than a bucket key needs: the limiter only ever
 * compares keys for equality, so all this has to do is not collide. The
 * published binding reference documents no ceiling on key length and the
 * runtime's own validation checks only that a key is a string, but a review
 * raised a possible 32-byte cap
 * (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928334734),
 * and staying under a limit that may or may not exist costs one `slice` where
 * being wrong about it costs every hosted sign-in.
 */
const CLIENT_KEY_LENGTH = 32;

/**
 * The key a request is counted against.
 *
 * The client's address, hashed and truncated. Hashed because it is a bucket to
 * count against rather than a record of who visited: nothing ever needs to read
 * an address back out. Where the platform reports no address — local
 * development, and the tests — every caller shares one key, which is the safe
 * direction for a limit.
 */
export async function clientBucket(request: Request): Promise<string> {
  const address = request.headers.get("cf-connecting-ip")?.trim();
  const bucket = address === undefined || address === "" ? ANONYMOUS_CLIENT : address;
  return (await sha256Hex(bucket)).slice(0, CLIENT_KEY_LENGTH);
}

/**
 * Whether this request is a person arriving at a page, rather than something a
 * page loaded on their behalf.
 *
 * `Sec-Fetch-Dest` is set by the browser and cannot be written by script, which
 * is what makes it worth trusting where `Referer` and `Origin` are not: those
 * are trivially forged by anything that is not a browser, and the threat here
 * is specifically a browser being aimed at us. Opening a link is
 * `document`; an `<img>`, an iframe or a `fetch` is `image`, `iframe` or
 * `empty`, and none of those is a person approving anything
 * (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928455536).
 *
 * **`Dest`, not `Site`.** A same-site `<img>` is still a subresource nobody
 * asked for, and a cross-site *navigation* is exactly how somebody opens the
 * link their terminal printed — so the site relationship answers the wrong
 * question in both directions. What matters is whether a person is looking at
 * the result.
 *
 * An absent header is allowed. Curl, older browsers and anything scripted send
 * none, and refusing them would break the manual path this page exists for;
 * they stay bounded by the limiter, which is what it is for.
 */
export function isTopLevelRequest(request: Request): boolean {
  const destination = request.headers.get("sec-fetch-dest");
  return destination === null || destination === "document";
}

/**
 * Whether this request is within its client's allowance.
 *
 * **An undeclared limiter allows everything, deliberately.** A self-hoster who
 * configures none gets no limit, which is the right default for a deployment
 * nobody else can reach; failing closed would mean a Worker that signs nobody
 * in until an operator had read a configuration reference. `docs/deploying.md`
 * says so where an operator will find it.
 */
export async function withinClientLimit(
  limiter: RateLimit | undefined,
  request: Request,
): Promise<boolean> {
  if (limiter === undefined) return true;
  return (await limiter.limit({ key: await clientBucket(request) })).success;
}
