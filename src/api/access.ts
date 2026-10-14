/**
 * Who a document is shared with, and how its owner reaches their own private page.
 *
 * ```
 * GET    /api/v1/docs/{docId}/access                          → 200 Access
 * PUT    /api/v1/docs/{docId}/access  {linkAccess}            → 200 Access
 * PUT    /api/v1/docs/{docId}/access/people/{email}  {role?}  → 200 Access
 * DELETE /api/v1/docs/{docId}/access/people/{email}           → 200 Access
 * DELETE /api/v1/docs/{docId}/access/requests/{email}         → 200 Access
 * GET    /api/v1/docs/{docId}/html                            → 200 the latest stored HTML
 * POST   /api/v1/docs/{docId}/open                            → 200 {url, expiresAt}
 * ```
 *
 * Everything is owner-only, and a document that is not yours is `404` exactly as
 * it is everywhere else. A client adds or removes **one address at a time**; it
 * never sends the whole list, so a retry cannot remove everyone by mistake and a
 * repeated `PUT` or `DELETE` answers `200` with the same list.
 *
 * **Approve is add; decline is one delete.** There is no approve route:
 * `PUT …/people/{email}` for an address with a pending request lists the person
 * and clears the request together, and sends the invite, which is how the
 * requester learns the answer. `DELETE …/requests/{email}` declines, silently.
 *
 * The plan is checked on the two writes that spend it — making a document
 * invited-only that is public now, and adding a person — and nowhere else.
 * Removing people, declining and switching to `anyone` never need it, which
 * extends the rule that losing the ability to publish must never cost the
 * ability to unshare. A lapsed plan keeps what exists: naming the mode a
 * document already has is a repeat, not a switch.
 *
 * **One operation layer.** `getAccess`, `setMode`, `addPerson`, `removePerson`
 * and `declineRequest` take the principal as a `Publisher` and answer with a
 * result, not a `Response`. The routes below map a result to the frozen JSON;
 * the share page maps the same results to HTML. So the plan gate, the invite
 * email, idempotency and the `document_access_changed` event cannot differ
 * between the two surfaces.
 */
import type { AnalyticsSink } from "../analytics.js";
import { maySharePrivately, type Publisher } from "../auth.js";
import { MAX_INVITES_PER_DOC, type Env } from "../config.js";
import {
  canManage,
  deleteAccessRequest,
  deleteInvite,
  findManagedDoc,
  findReadableDoc,
  findServableVersion,
  insertInvite,
  ownerEmail,
  readAccess,
  setInviteRole,
  setLinkAccess,
  type InviteRole,
  type LinkAccess,
} from "../db.js";
import { emailConfigured, inviteMessage, sendEmail } from "../email.js";
import { docNotFound, errorResponse } from "../errors.js";
import { sha256Hex } from "../hash.js";
import { isDocId } from "../ids.js";
import { withinLimit } from "../limits.js";
import { normalizeEmail } from "../approval/providers.js";
import { limitReached } from "../plans.js";
import { grantUrl } from "../private.js";
import { readBodyWithin } from "../quota.js";
import { readerSignInConfigured } from "../reader-config.js";
import { stringField } from "../account.js";
import { STORED_CONTENT_TYPE, versionObjectKey } from "../storage.js";
import { publicDocUrl } from "../urls.js";

const NO_STORE = { "cache-control": "no-store" };

/** The longest address the Email Service will take as a recipient (RFC 5321). */
const MAX_ADDRESS_LENGTH = 254;

/** The only values `linkAccess` takes. */
function parseLinkAccess(value: unknown): LinkAccess | null {
  return value === "anyone" || value === "invited" ? value : null;
}

/** The only values `role` takes. */
function parseInviteRole(value: unknown): InviteRole | null {
  return value === "view" || value === "comment" ? value : null;
}

/**
 * The address to store and mail, or null when it is not one.
 *
 * `normalizeEmail` is the folding `accounts.email` uses and stays as it is; this
 * adds what an address needs before it becomes a stored row and an Email
 * Service recipient: no control characters, and no longer than the protocol
 * allows.
 */
function inviteAddress(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (email === null || email.length > MAX_ADDRESS_LENGTH || /[\u0000-\u001f\u007f]/.test(email)) return null;
  return email;
}

/**
 * The `402` for a plan that cannot share privately. An account publisher gets
 * the upgrade link the plan machinery builds; a license-key publisher manages
 * their plan in Copilot, so they get a Copilot-specific message with no
 * OpenArtifacts command to run and no checkout to sell.
 */
export function planRefusal(env: Env, publisher: Publisher): Response {
  return publisher.authKind === "account"
    ? limitReached(env, publisher, "privateSharing", "Private sharing needs a paid plan.")
    : errorResponse("limit_reached", "Your Copilot plan does not include private sharing.", undefined, {
      plan: publisher.plan, limit: "privateSharing",
    });
}

/** The document's mode, invite list and pending requests, as `readAccess` reads them. */
export type AccessState = NonNullable<Awaited<ReturnType<typeof readAccess>>>;

/**
 * Why an operation did nothing. `not_found` covers a missing, deleted and
 * someone else's document alike; `full` is the 101st person.
 */
export type AccessRefusal = "not_found" | "bad_email" | "full" | "plan";

/**
 * What an operation did. `state` is read after the write, and `changed` says
 * whether the write changed anything, so a caller can tell a switch from a
 * repeat: the share page shows its notice only after a real switch to private.
 */
export type AccessResult =
  | { ok: true; state: AccessState; changed: boolean }
  | { ok: false; refusal: AccessRefusal };

const refused = (refusal: AccessRefusal): AccessResult => ({ ok: false, refusal });

/** The access list of a document `principal` manages. */
export async function getAccess(env: Env, principal: Publisher, docId: string): Promise<AccessResult> {
  if (!isDocId(docId) || !(await canManage(env.DB, docId, principal.owner))) return refused("not_found");
  const state = await readAccess(env.DB, docId);
  return state === null ? refused("not_found") : { ok: true, state, changed: false };
}

/**
 * Switch a document's link access. Needs the plan only when it turns a public
 * document private; naming the mode it already has is a repeat that answers
 * `200` on any plan, and switching to `anyone` never needs one. The invite
 * list and the pending requests stay as they are in both directions.
 */
export async function setMode(
  env: Env,
  principal: Publisher,
  docId: string,
  mode: LinkAccess,
  analytics: AnalyticsSink,
): Promise<AccessResult> {
  const doc = isDocId(docId) ? await findManagedDoc(env.DB, docId, principal.owner) : null;
  if (doc === null) return refused("not_found");
  if (mode === "invited" && doc.link_access === "anyone" && !maySharePrivately(env, principal)) {
    return refused("plan");
  }

  const changed = await setLinkAccess(env.DB, docId, principal.owner, mode);
  const state = await readAccess(env.DB, docId);
  if (state === null) return refused("not_found");
  if (changed) recordChange(analytics, docId, doc.publisher_id, state);
  return { ok: true, state, changed };
}

/**
 * Add a person, which is also how a request is approved. An address that is
 * already on the list stays as it is, unless `role` names a different one. The
 * invite email goes out only on the call that added the address, so a retry does
 * not mail the same person twice. Needs the plan.
 */
export async function addPerson(
  env: Env,
  requestUrl: URL,
  principal: Publisher,
  docId: string,
  rawEmail: string,
  role: InviteRole | undefined,
  analytics: AnalyticsSink,
): Promise<AccessResult> {
  const doc = isDocId(docId) ? await findManagedDoc(env.DB, docId, principal.owner) : null;
  if (doc === null) return refused("not_found");
  const email = inviteAddress(rawEmail);
  if (email === null) return refused("bad_email");
  if (!maySharePrivately(env, principal)) return refused("plan");

  const added = await insertInvite(env.DB, docId, principal.owner, email, Date.now(), MAX_INVITES_PER_DOC, role);
  const roleChanged =
    !added && role !== undefined && (await setInviteRole(env.DB, docId, principal.owner, email, role));

  // One read after the write answers everything below: the cap check, the
  // response and the count the event carries.
  const state = await readAccess(env.DB, docId);
  if (state === null) return refused("not_found");
  if (!added && !state.people.some((person) => person.email === email)) return refused("full");

  if (added) await invite(env, requestUrl, doc.publisher_id, docId, doc.title, email);
  if (added || roleChanged) recordChange(analytics, docId, doc.publisher_id, state);
  return { ok: true, state, changed: added || roleChanged };
}

/** Remove a person. Never needs the plan. Removing an absent address is a repeat. */
export async function removePerson(
  env: Env,
  principal: Publisher,
  docId: string,
  rawEmail: string,
  analytics: AnalyticsSink,
): Promise<AccessResult> {
  const doc = isDocId(docId) ? await findManagedDoc(env.DB, docId, principal.owner) : null;
  if (doc === null) return refused("not_found");
  const email = inviteAddress(rawEmail);
  if (email === null) return refused("bad_email");

  const removed = await deleteInvite(env.DB, docId, principal.owner, email);
  const state = await readAccess(env.DB, docId);
  if (state === null) return refused("not_found");
  if (removed) recordChange(analytics, docId, doc.publisher_id, state);
  return { ok: true, state, changed: removed };
}

/**
 * Decline a request. Never needs the plan, tells the requester nothing, and
 * records no event: requests are not recorded in v1, and a decline changes
 * neither the mode nor the list. Declining an address with no request is a repeat.
 */
export async function declineRequest(
  env: Env,
  principal: Publisher,
  docId: string,
  rawEmail: string,
): Promise<AccessResult> {
  if (!isDocId(docId) || !(await canManage(env.DB, docId, principal.owner))) return refused("not_found");
  const email = inviteAddress(rawEmail);
  if (email === null) return refused("bad_email");

  await deleteAccessRequest(env.DB, docId, principal.owner, email);
  const state = await readAccess(env.DB, docId);
  return state === null ? refused("not_found") : { ok: true, state, changed: false };
}

/**
 * The state an access write left behind, recorded the way publication events
 * are. `ownerId` is the publisher's app-sites id as the push events carry it,
 * resolved by the ownership read, so a linked license key, an account token and
 * the share page's session count one publisher once. `people` is a count.
 */
function recordChange(analytics: AnalyticsSink, docId: string, ownerId: string, state: AccessState): void {
  analytics.record({
    name: "document_access_changed",
    docId,
    atMs: Date.now(),
    ownerId,
    linkAccess: state.link_access,
    people: state.people.length,
  });
}

/**
 * Mail the invite, best effort. The address is on the list whether or not this
 * succeeds, and the link always points at the sacrificial domain, so a failure
 * costs the invitee an email and nothing else. Bounded per publisher by a
 * binding, keyed by the canonical publisher id so a license key, its linked
 * account and the share page draw on one allowance.
 */
async function invite(
  env: Env,
  requestUrl: URL,
  publisherId: string,
  docId: string,
  title: string,
  email: string,
): Promise<void> {
  if (!emailConfigured(env)) return;
  if (!(await withinLimit(env.INVITE_EMAIL_LIMITER, await sha256Hex(`invite:${publisherId}`)))) return;
  const sharer = await ownerEmail(env.DB, publisherId);
  await sendEmail(env, email, inviteMessage(sharer, title, publicDocUrl(env, requestUrl, docId), email));
}

/** The frozen JSON for an `Access`: `url` is always the canonical link, never a grant. */
function accessResponse(env: Env, requestUrl: URL, docId: string, state: AccessState): Response {
  return Response.json(
    {
      docId,
      url: publicDocUrl(env, requestUrl, docId),
      linkAccess: state.link_access,
      email: emailConfigured(env),
      people: state.people.map((person) => ({ email: person.email, role: person.role, addedAt: person.created_at })),
      requests: state.requests.map((request) => ({ email: request.email, requestedAt: request.created_at })),
    },
    { headers: NO_STORE },
  );
}

/** `%40` or a bare `@`: both arrive here, and a malformed escape is just a bad address. */
function decodeAddress(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/**
 * The optional `{role}` body of `PUT …/people/{email}`: undefined when the
 * body is absent or empty, null when it is anything but `{}` or one valid role.
 * Not `stringField`, which treats an empty body as invalid and demands exactly
 * one key.
 */
async function roleOf(request: Request): Promise<InviteRole | undefined | null> {
  const raw = await readBodyWithin(request, 1024);
  if (raw === null) return null;
  if (raw.byteLength === 0) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length === 0) return undefined;
  return keys.length === 1 && "role" in fields ? parseInviteRole(fields.role) : null;
}

/** Map a refusal to the frozen JSON errors; a success to the `Access`. */
function jsonOf(env: Env, requestUrl: URL, publisher: Publisher, docId: string, result: AccessResult): Response {
  if (result.ok) return accessResponse(env, requestUrl, docId, result.state);
  switch (result.refusal) {
    case "not_found":
      return docNotFound(docId);
    case "bad_email":
      return errorResponse("bad_request", "That is not an email address.");
    case "full":
      return errorResponse("bad_request", `A document can be shared with at most ${MAX_INVITES_PER_DOC} people.`);
    case "plan":
      return planRefusal(env, publisher);
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
  const [section, kind, person, ...rest] = extra;
  const method = request.method;

  // Everything but `…/html` is private sharing, and an unconfigured server has
  // none of it: no route, as on a Worker that predates the feature. After
  // authentication and before any plan gate, so the answer is `404` however the
  // caller's plan stands. `…/html` is owner-only bytes and `get` depends on it.
  if (section !== "html" && !readerSignInConfigured(env)) return null;

  const access = section === "access" && rest.length === 0;
  const people = access && kind === "people" && person !== undefined;
  const requests = access && kind === "requests" && person !== undefined;
  const route =
    (access && kind === undefined && (method === "GET" || method === "PUT")) ||
    (people && (method === "PUT" || method === "DELETE")) ||
    (requests && method === "DELETE") ||
    (section === "html" && kind === undefined && method === "GET") ||
    (section === "open" && kind === undefined && method === "POST");
  if (!route) return null;

  if (section === "html" || section === "open") {
    if (!isDocId(docId) || !(await canManage(env.DB, docId, publisher.owner))) return docNotFound(docId);
    return section === "html" ? await storedHtml(env, docId) : await openOwn(env, publisher, docId, url);
  }

  let result: AccessResult;
  if (people && method === "PUT") {
    const role = await roleOf(request);
    if (role === null) return errorResponse("bad_request", 'Expected {"role": "view" | "comment"} or no body.');
    result = await addPerson(env, url, publisher, docId, decodeAddress(person), role, analytics);
  } else if (people) {
    result = await removePerson(env, publisher, docId, decodeAddress(person), analytics);
  } else if (requests) {
    result = await declineRequest(env, publisher, docId, decodeAddress(person));
  } else if (method === "PUT") {
    const mode = parseLinkAccess(await stringField(request, "linkAccess"));
    if (mode === null) {
      return errorResponse("bad_request", 'Expected {"linkAccess": "anyone" | "invited"}.');
    }
    result = await setMode(env, publisher, docId, mode, analytics);
  } else {
    result = await getAccess(env, publisher, docId);
  }
  return jsonOf(env, url, publisher, docId, result);
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
 * invited-only document that is its publisher's origin with a 60-second grant whose
 * principal is the caller's owner id, which the origin checks like any other. A
 * client opens it and discards it: it is never printed, stored or returned in a
 * publish receipt, because agent wrappers print receipts into transcripts.
 */
async function openOwn(env: Env, publisher: Publisher, docId: string, requestUrl: URL): Promise<Response> {
  // The same read `/open` and the publisher's origin make, so the three agree
  // on who may read. The label comes from the document's own owner, which for a
  // linked publisher is not necessarily the caller's id.
  const found = await findReadableDoc(env.DB, docId, null, publisher.owner);
  if (found === null || found.deleted_at !== null || !found.allowed) return docNotFound(docId);
  const now = Date.now();
  if (found.link_access === "anyone") {
    return Response.json({ url: publicDocUrl(env, requestUrl, docId), expiresAt: now + 60_000 }, { headers: NO_STORE });
  }
  const grant = await grantUrl(env, found.owner, { docId, pinned: null }, publisher.owner, now);
  return grant
    ? Response.json(grant, { headers: NO_STORE })
    : errorResponse("not_found", "No API route for this request.");
}
