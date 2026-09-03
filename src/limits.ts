/**
 * The per-client limits on the three routes that answer without a credential.
 *
 * Minting a device code, looking one up on the approval page, and starting a
 * handshake all have to work for somebody who has nothing to present, so the
 * caller's address is the only thing there is to count against. This module is
 * how that address becomes a limiter key, and it lives apart from both callers
 * because `src/device.ts` and `src/approval/handler.ts` already point at each
 * other and neither should import the other for this.
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
