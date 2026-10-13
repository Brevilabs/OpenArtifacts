/**
 * Who a document is shared with, and how its owner reaches their own private page.
 *
 * ```
 * GET    /api/v1/docs/{docId}/access                  → 200 Access
 * PUT    /api/v1/docs/{docId}/access  {linkAccess}    → 200 Access
 * PUT    /api/v1/docs/{docId}/access/people/{email}   → 200 Access
 * DELETE /api/v1/docs/{docId}/access/people/{email}   → 200 Access
 * GET    /api/v1/docs/{docId}/html                    → 200 the latest stored HTML
 * POST   /api/v1/docs/{docId}/open                    → 200 {url, expiresAt}
 * ```
 *
 * Everything is owner-only, and a document that is not yours is `404` exactly as
 * it is everywhere else. A client adds or removes **one address at a time**; it
 * never sends the whole list, so a retry cannot remove everyone by mistake and a
 * repeated `PUT` or `DELETE` answers `200` with the same list.
 *
 * The plan is checked on the two writes that spend it — making a document
 * invited-only, and adding a person — and nowhere else. Removing people and
 * switching back to `anyone` never need it, which extends the rule that losing
 * the ability to publish must never cost the ability to unshare. A lapsed plan
 * keeps what exists.
 */
import type { AnalyticsSink } from "../analytics.js";
import { maySharePrivately, type Publisher } from "../auth.js";
import { MAX_INVITES_PER_DOC, type Env } from "../config.js";
import {
  deleteInvite,
  findServableVersion,
  insertInvite,
  ownerEmail,
  ownsLiveDoc,
  readAccess,
  setLinkAccess,
  type LinkAccess,
} from "../db.js";
import { emailConfigured, inviteMessage, sendEmail } from "../email.js";
import { docNotFound, errorResponse } from "../errors.js";
import { sha256Hex } from "../hash.js";
import { isDocId } from "../ids.js";
import { withinLimit } from "../limits.js";
import { normalizeEmail } from "../approval/providers.js";
import { limitReached } from "../plans.js";
import { grantUrl, privateSharingConfigured } from "../private.js";
import { stringField } from "../account.js";
import { STORED_CONTENT_TYPE, versionObjectKey } from "../storage.js";
import { publicDocUrl } from "../urls.js";

const NO_STORE = { "cache-control": "no-store" };

/** The only values `linkAccess` takes. */
export function parseLinkAccess(value: unknown): LinkAccess | null {
  return value === "anyone" || value === "invited" ? value : null;
}

/**
 * The refusal for making a document private when the plan or the deployment
 * cannot, or null when it may go ahead. One check for `POST /docs`, the mode
 * switch and adding a person, so the three cannot drift apart.
 */
export function refusePrivate(env: Env, publisher: Publisher): Response | null {
  if (!maySharePrivately(env, publisher)) {
    // A license-key publisher manages their plan in Copilot: no CLI command to run, no OpenArtifacts checkout to sell.
    return publisher.authKind === "account"
      ? limitReached(env, publisher, "privateSharing", "Private sharing needs a paid plan.")
      : errorResponse("limit_reached", "Your Copilot plan does not include private sharing.", undefined, {
        plan: publisher.plan, limit: "privateSharing",
      });
  }
  if (!privateSharingConfigured(env)) {
    return errorResponse("bad_request", "This server is not set up for private documents.");
  }
  return null;
}

type DocAccess = NonNullable<Awaited<ReturnType<typeof readAccess>>>;

function accessResponse(env: Env, requestUrl: URL, docId: string, access: DocAccess): Response {
  return Response.json(
    {
      docId,
      url: publicDocUrl(env, requestUrl, docId),
      linkAccess: access.link_access,
      people: access.people.map((person) => ({ email: person.email, addedAt: person.created_at })),
    },
    { headers: NO_STORE },
  );
}

/** `%40` or a bare `@`: both arrive here, and a malformed escape is just a bad address. */
function addressOf(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return normalizeEmail(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * The routes under `/api/v1/docs/{docId}/…`, or null when `extra` names none, so
 * the router can answer its usual `404`.
 */
export async function handleDocSection(
  request: Request,
  url: URL,
  env: Env,
  publisher: Publisher,
  docId: string,
  extra: string[],
  analytics: AnalyticsSink,
): Promise<Response | null> {
  const [section, people, person, ...rest] = extra;
  const method = request.method;

  const access = section === "access" && rest.length === 0;
  const route =
    (access && people === undefined && (method === "GET" || method === "PUT")) ||
    (access && people === "people" && person !== undefined && (method === "PUT" || method === "DELETE")) ||
    (section === "html" && people === undefined && method === "GET") ||
    (section === "open" && people === undefined && method === "POST");
  if (!route) return null;

  if (!isDocId(docId) || !(await ownsLiveDoc(env.DB, docId, publisher.owner))) return docNotFound(docId);

  if (section === "html") return await storedHtml(env, docId);
  if (section === "open") return await openOwn(env, publisher, docId, url);
  const now = Date.now();
  const email = people === "people" ? addressOf(person) : null;
  if (people === "people" && email === null) {
    return errorResponse("bad_request", "That is not an email address.");
  }

  let added = false;
  if (method === "PUT" && email === null) {
    const mode = parseLinkAccess(await stringField(request, "linkAccess"));
    if (mode === null) {
      return errorResponse("bad_request", 'Expected {"linkAccess": "anyone" | "invited"}.');
    }
    const refused = mode === "invited" ? refusePrivate(env, publisher) : null;
    if (refused) return refused;
    if (!(await setLinkAccess(env.DB, docId, publisher.owner, mode))) return docNotFound(docId);
  } else if (method === "PUT" && email !== null) {
    const refused = refusePrivate(env, publisher);
    if (refused) return refused;
    added = await insertInvite(env.DB, docId, publisher.owner, email, now, MAX_INVITES_PER_DOC);
  } else if (method === "DELETE" && email !== null) {
    await deleteInvite(env.DB, docId, publisher.owner, email);
  }

  // One read after the write answers everything below: the response, the cap
  // check, the invite's title and the count the event carries.
  const state = await readAccess(env.DB, docId);
  if (state === null) return docNotFound(docId);
  if (method === "GET") return accessResponse(env, url, docId, state);

  if (method === "PUT" && email !== null) {
    if (!added && !state.people.some((invited) => invited.email === email)) {
      return errorResponse(
        "bad_request",
        `A document can be shared with at most ${MAX_INVITES_PER_DOC} people.`,
      );
    }
    // Only the call that added the address sends the invite, so a retry does
    // not mail the same person twice.
    if (added) await invite(env, url, publisher, docId, state.title, email);
  }
  analytics.record({
    name: "document_access_changed",
    docId,
    atMs: now,
    ownerId: publisher.owner,
    linkAccess: state.link_access,
    people: state.people.length,
  });
  return accessResponse(env, url, docId, state);
}

/**
 * Mail the invite, best effort. The address is on the list whether or not this
 * succeeds, and the link always points at the sacrificial domain, so a failure
 * costs the invitee an email and nothing else. Bounded per owner by a binding.
 */
async function invite(
  env: Env,
  requestUrl: URL,
  publisher: Publisher,
  docId: string,
  title: string,
  email: string,
): Promise<void> {
  if (!emailConfigured(env)) return;
  if (!(await withinLimit(env.INVITE_EMAIL_LIMITER, await sha256Hex(`invite:${publisher.owner}`)))) return;
  const sharer = await ownerEmail(env.DB, publisher.owner);
  await sendEmail(env, email, inviteMessage(sharer, title, publicDocUrl(env, requestUrl, docId), email));
}

/**
 * The owner's latest stored bytes, so `openartifacts get` keeps working once the
 * page is private and its public url stops answering. A browser cannot reach this:
 * it needs a bearer header, and the sandbox says so anyway.
 */
async function storedHtml(env: Env, docId: string): Promise<Response> {
  const found = await findServableVersion(env.DB, docId, null);
  const object = found?.version ? await env.DOCS.get(versionObjectKey(docId, found.version)) : null;
  if (object === null) return docNotFound(docId);
  return new Response(object.body, {
    headers: {
      "content-type": STORED_CONTENT_TYPE,
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Where the owner's browser opens their own page, with no sign-in. For an
 * invited-only document that is its own origin with a 60-second grant whose
 * principal is the caller's owner id, which the origin checks like any other. A
 * client opens it and discards it: it is never printed, stored or returned in a
 * publish receipt, because agent wrappers print receipts into transcripts.
 */
async function openOwn(env: Env, publisher: Publisher, docId: string, requestUrl: URL): Promise<Response> {
  const access = await readAccess(env.DB, docId);
  if (access === null) return docNotFound(docId);
  const now = Date.now();
  if (access.link_access === "anyone") {
    return Response.json({ url: publicDocUrl(env, requestUrl, docId), expiresAt: now + 60_000 }, { headers: NO_STORE });
  }
  const grant = await grantUrl(env, { docId, pinned: null }, publisher.owner, now);
  return grant
    ? Response.json(grant, { headers: NO_STORE })
    : errorResponse("bad_request", "This server is not set up for private documents.");
}
