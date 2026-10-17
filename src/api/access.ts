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
 * Everything is owner-only except `…/html`, which is open to anyone who can read
 * the document (an invited reviewer's agent needs the text to quote it), and a
 * document that is not yours is `404` exactly as it is everywhere else.
 * The comment routes under the same prefix (`…/threads`, `…/comments`) are `src/comments/routes.ts`. A client adds or removes **one address at a time**; it
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
 * document already has is a repeat, not a switch, and so is adding an address
 * that is already listed with no new role and no request to approve.
 *
 * **One operation layer.** `getAccess`, `setMode`, `addPerson`, `removePerson`
 * and `declineRequest` take the principal as a `Publisher` and answer with a
 * result, not a `Response`. The routes below map a result to the frozen JSON;
 * the share page maps the same results to HTML. So the plan gate, the invite
 * email, idempotency and the `document_access_changed` event cannot differ
 * between the two surfaces.
 */
import type { AnalyticsSink } from "../analytics.js";
import { maySharePrivately, mayGrantRole, type Publisher } from "../auth.js";
import { MAX_INVITES_PER_DOC, MAX_NEW_INVITES_PER_OWNER_PER_DAY, type Env } from "../config.js";
import {
  canManage,
  deleteAccessRequest,
  deleteInvite,
  findManagedDoc,
  findReadableDoc,
  insertInvite,
  ownerEmail,
  readAccess,
  setInviteRole,
  setLinkAccess,
  type LinkAccess,
} from "../db.js";
import { commentRoute } from "../comments/routes.js";
import { emailConfigured, inviteMessage, sendEmail } from "../email.js";
import { docNotFound, errorResponse } from "../errors.js";
import { sha256Hex } from "../hash.js";
import { isDocId } from "../ids.js";
import { withinLimit } from "../limits.js";
import { normalizeEmail } from "../approval/providers.js";
import { writeManifest } from "../manifest.js";
import { limitReached, upgradeUrl as upgradeLink } from "../plans.js";
import { DEFAULT_ROLE, parseInviteRole, ROLES, type InviteRole } from "../roles.js";
import { accountPlan } from "../entitlement.js";
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
export function parseLinkAccess(value: unknown): LinkAccess | null {
  return value === "anyone" || value === "invited" ? value : null;
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
export function planRefusal(env: Env, publisher: Publisher, what = "Private sharing", limit = "privateSharing"): Response {
  return publisher.authKind === "account"
    ? limitReached(env, publisher, limit, `${what} needs a paid plan.`)
    : errorResponse("limit_reached", `Your Copilot plan does not include ${what.toLowerCase()}.`, undefined, {
      plan: publisher.plan, limit,
    });
}

/** The document's mode, invite list and pending requests, as `readAccess` reads them. */
export type AccessState = NonNullable<Awaited<ReturnType<typeof readAccess>>>;

/**
 * Why an operation did nothing. `not_found` covers a missing, deleted and
 * someone else's document alike; `full` is the 101st person; `invite_quota` is
 * the owner's daily cap on new invites; `plan` is a switch to private the plan
 * lacks, `plan_people` an add or role change on a plan without private sharing,
 * and `plan_comments` one at `comment` on a plan with private sharing but not
 * comments (the same `402`, worded for the operation and naming the flag).
 */
export type AccessRefusal = "not_found" | "bad_email" | "full" | "plan" | "plan_people" | "plan_comments" | "invite_quota";

/**
 * What an operation did. `state` is read after the write, and `changed` says
 * whether the write changed the link access or the invite list, so a caller can
 * tell a switch from a repeat: the Share popover counts only a real switch to
 * private as its own (`FRAME_SCRIPT`). A decline, a read and a repeat answer
 * `false`, even when a pending request was deleted: `changed` lines up with when
 * `document_access_changed` is recorded, and requests are not recorded.
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
 *
 * **A publisher without the plan never writes `invited`.** The document read at
 * the top can be stale by the time of the write: a lapsed publisher's `invited`
 * request that saw `invited` and skipped the check could otherwise run after a
 * concurrent `anyone` and make the document private again without the plan. So
 * for that publisher the decision is made on a read taken after the fact, and
 * it never writes: `invited` already answers the repeat, anything else is the
 * `402`. The entitled path writes as before, and a write that loses a race
 * simply reports `changed: false`.
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
  if (mode === "invited" && !maySharePrivately(env, principal)) {
    const current = await readAccess(env.DB, docId);
    if (current === null) return refused("not_found");
    if (current.link_access !== "invited") return refused("plan");
    // A repeat, but also the retry of a switch whose manifest put failed before
    // the plan lapsed: without this the manifest could keep saying `anyone`.
    await writeManifest(env, docId);
    return { ok: true, state: current, changed: false };
  }

  const changed = await setLinkAccess(env.DB, docId, principal.owner, mode);
  const state = await readAccess(env.DB, docId);
  if (state === null) return refused("not_found");
  if (changed) recordChange(analytics, docId, doc.publisher_id, state);
  // Last, so a failed put cannot swallow the event; written even on a repeat.
  await writeManifest(env, docId);
  return { ok: true, state, changed };
}

/**
 * Add a person, which is also how a request is approved. An address that is
 * already on the list stays as it is, unless `role` names a different one. The
 * invite email goes out only on the call that added the address, so a retry does
 * not mail the same person twice, and after the answer (`ctx.waitUntil`), so the
 * owner never waits on the mail service. Needs the plan, except for a pure repeat: an
 * address already listed, with no role or the same role and no request to
 * approve, answers on any plan, mails nobody and records nothing. A role
 * change, a new address and an approval still reach the plan check.
 * A new address also counts against the owner's daily invite cap.
 */
export async function addPerson(
  env: Env,
  requestUrl: URL,
  principal: Publisher,
  docId: string,
  rawEmail: string,
  role: InviteRole | undefined,
  analytics: AnalyticsSink,
  ctx: ExecutionContext,
): Promise<AccessResult> {
  const result = await addWithoutManifest(env, requestUrl, principal, docId, rawEmail, role, analytics, ctx);
  // After the email is scheduled and the event recorded, so a failed put cannot
  // swallow either: the retry it invites is a pure repeat, which mails nobody.
  // Written on a pure repeat too, since that retry is what repairs a failed
  // manifest write.
  if (result.ok) await writeManifest(env, docId);
  return result;
}

/** `addPerson` without the manifest snapshot, for a caller that snapshots once after a batch. */
export async function addWithoutManifest(
  env: Env,
  requestUrl: URL,
  principal: Publisher,
  docId: string,
  rawEmail: string,
  role: InviteRole | undefined,
  analytics: AnalyticsSink,
  ctx: ExecutionContext,
): Promise<AccessResult> {
  const doc = isDocId(docId) ? await findManagedDoc(env.DB, docId, principal.owner) : null;
  if (doc === null) return refused("not_found");
  const email = inviteAddress(rawEmail);
  if (email === null) return refused("bad_email");
  const before = await readAccess(env.DB, docId);
  if (before === null) return refused("not_found");
  const listed = before.people.find((person) => person.email === email);
  // A pure repeat: already listed, no role or the same role, and no request to approve. Like naming the mode a document already has, it answers on any plan, mails nobody and records nothing.
  if (listed && (role === undefined || role === listed.role) && !before.requests.some((r) => r.email === email)) {
    return { ok: true, state: before, changed: false };
  }
  // A role-less add takes the default where the plan grants it, else the highest rung the plan does
  // grant: `view` on a plan with private sharing but not comments. Where the server has no comments
  // no role is drawn, and an unseen grant is `view`, so turning comments on later makes no one a commenter.
  const grantable = grantableRoles(env, principal);
  const granted = role ?? (grantable?.includes(DEFAULT_ROLE) ? DEFAULT_ROLE : (grantable?.at(-1) ?? "view"));
  // The flag of the role being granted, whether the person is new or already listed, and on a server
  // without comments too, where a stored `comment` would grant commenting once they are bound: a change
  // to a lower role goes through the same check as a higher one, since "Remove" already covers a demotion.
  // Private sharing is what adding anyone needs, so it is the flag named unless the plan has it.
  if (!mayGrantRole(env, principal, granted)) {
    return refused(maySharePrivately(env, principal) ? "plan_comments" : "plan_people");
  }

  const added = await insertInvite(env.DB, docId, principal.owner, email, Date.now(), MAX_INVITES_PER_DOC, granted);
  const roleChanged =
    !added && role !== undefined && (await setInviteRole(env.DB, docId, principal.owner, email, role));

  // One read after the write answers everything below: the cap check, the
  // response and the count the event carries.
  const state = await readAccess(env.DB, docId);
  if (state === null) return refused("not_found");
  if (!added && !state.people.some((person) => person.email === email)) {
    return refused(state.people.length >= MAX_INVITES_PER_DOC ? "full" : "invite_quota");
  }

  if (added) ctx.waitUntil(invite(env, requestUrl, doc.publisher_id, docId, doc.title, email, granted));
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
  await writeManifest(env, docId);
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
 * Mail the invite, best effort, after the answer (`waitUntil`): the answer does
 * not wait on the mail service, and says only that the server can mail
 * (`Access.email`), never that this one was delivered. The address is on the
 * list whether or not this succeeds, and the link always points at the
 * sacrificial domain, so a failure costs the invitee an email and nothing else.
 * It never throws: the limiter and the sharer's address are inside the `try`
 * too, so nothing here can surface as an unhandled rejection. Bounded per
 * publisher by a binding, keyed by the canonical publisher id so a license key,
 * its linked account and the share page draw on one allowance.
 */
async function invite(
  env: Env,
  requestUrl: URL,
  publisherId: string,
  docId: string,
  title: string,
  email: string,
  role: InviteRole,
): Promise<void> {
  try {
    if (!emailConfigured(env)) return;
    if (!(await withinLimit(env.INVITE_EMAIL_LIMITER, await sha256Hex(`invite:${publisherId}`)))) return;
    const sharer = await ownerEmail(env.DB, publisherId);
    await sendEmail(env, email, inviteMessage(sharer, title, publicDocUrl(env, requestUrl, docId), email, role));
  } catch (error) {
    console.error("invite email failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * The roles `publisher` may grant now: the rungs of the ladder whose plan flag
 * their plan has. `[]` for a free or lapsed owner, undefined where the server has
 * no comments, and then no surface draws a role.
 */
export function grantableRoles(env: Env, publisher: Publisher): InviteRole[] | undefined {
  return env.COMMENTS === undefined ? undefined : ROLES.filter((role) => mayGrantRole(env, publisher, role));
}

/**
 * The account owner with the plan their Share view and their writes both go by:
 * the effective plan (an expired one has lapsed), rechecked on the usual hour,
 * and after `PLAN_RECHECK_MS`, unless the license server is backing off, when the
 * cached plan grants no role. So an owner back from checkout sees Add people on
 * their next open and can use it, a free owner's opens are not each a call to the
 * license server, and a lapsed owner is never shown what the write refuses.
 */
export async function withCurrentPlan(env: Env, owner: Publisher): Promise<Publisher> {
  if (owner.authKind !== "account") return owner;
  const grantsNone = grantableRoles(env, owner)?.length === 0;
  return { ...owner, plan: (await accountPlan(env, owner.owner, grantsNone ? { maxAgeMs: PLAN_RECHECK_MS } : {})).plan };
}

/** How old a plan that grants no role may be when its owner opens Share: shorter than any checkout. */
const PLAN_RECHECK_MS = 30_000;

/**
 * The frozen `Access` object: `url` is always the canonical link, never a grant.
 * The popover's owner view is this plus who is asking, so both surfaces name
 * the same fields.
 */
export function accessBody(env: Env, requestUrl: URL, docId: string, state: AccessState, publisher: Publisher) {
  const roles = grantableRoles(env, publisher);
  return {
    docId,
    url: publicDocUrl(env, requestUrl, docId),
    linkAccess: state.link_access,
    // The roles the caller may grant now, in ladder order; left out where the server has no comments.
    ...(roles === undefined ? {} : { roles }),
    // Only an account has a checkout to go to; a license key's plan is managed in Copilot, as in `planRefusal`.
    ...(roles?.length === 0 && publisher.authKind === "account" && upgradeLink(env) !== undefined ? { upgradeUrl: upgradeLink(env) } : {}),
    email: emailConfigured(env),
    people: state.people.map((person) => ({ email: person.email, role: person.role, addedAt: person.created_at })),
    requests: state.requests.map((request) => ({ email: request.email, requestedAt: request.created_at })),
  };
}

function accessResponse(env: Env, requestUrl: URL, publisher: Publisher, docId: string, state: AccessState): Response {
  return Response.json(accessBody(env, requestUrl, docId, state, publisher), { headers: NO_STORE });
}

/** `%40` or a bare `@`: both arrive here, and a malformed escape is just a bad address. */
export function decodeAddress(segment: string): string {
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
export async function roleOf(request: Request): Promise<InviteRole | undefined | null> {
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
  return result.ok
    ? accessResponse(env, requestUrl, publisher, docId, result.state)
    : refusalResponse(env, publisher, docId, result.refusal);
}

/** The frozen JSON error for a refused operation. The Share popover's routes use it too. */
export function refusalResponse(env: Env, publisher: Publisher, docId: string, refusal: AccessRefusal): Response {
  switch (refusal) {
    case "not_found":
      return docNotFound(docId);
    case "bad_email":
      return errorResponse("bad_request", "That is not an email address.");
    case "full":
      return errorResponse("bad_request", `A document can be shared with at most ${MAX_INVITES_PER_DOC} people.`);
    case "plan":
      return planRefusal(env, publisher);
    case "plan_people":
      return planRefusal(env, publisher, "Adding people");
    case "plan_comments":
      return planRefusal(env, publisher, "Letting people comment", "comments");
    case "invite_quota":
      return errorResponse("quota_exceeded", `You have added ${MAX_NEW_INVITES_PER_OWNER_PER_DAY} new people in the last 24 hours. Try again later.`);
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
  ctx: ExecutionContext,
): Promise<Response | null> {
  const [section, kind, person, ...rest] = extra;
  const method = request.method;

  // Everything but `…/html` is private sharing, and an unconfigured server has
  // none of it: no route, as on a Worker that predates the feature. After
  // authentication and before any plan gate, so the answer is `404` however the
  // caller's plan stands. `…/html` is the stored bytes and `get` depends on it.
  if (section !== "html" && !readerSignInConfigured(env)) return null;

  // Comments, for an agent: an account token or a license key writes as an
  // agent acting for its account. This runs ahead of the access routes and
  // claims only the exact comment shapes (threads, comments), so it
  // never takes an access path; null hands the segments to the routes below. A
  // new comment shape must not overlap an access one, or it would shadow it.
  const comments = await commentRoute(request, url, env, { publisher, kind: "agent", ctx }, docId, extra);
  if (comments !== null) return comments;

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

  if (section === "html") return await storedHtml(env, publisher, docId);
  if (section === "open") {
    if (!isDocId(docId) || !(await canManage(env.DB, docId, publisher.owner))) return docNotFound(docId);
    return await openOwn(env, publisher, docId, url);
  }

  let result: AccessResult;
  if (people && method === "PUT") {
    const role = await roleOf(request);
    if (role === null) return errorResponse("bad_request", 'Expected {"role": "view" | "comment"} or no body.');
    result = await addPerson(env, url, publisher, docId, decodeAddress(person), role, analytics, ctx);
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
 * The latest stored bytes of a document the caller can read, so `openartifacts
 * get` keeps working once the page is private and its public url stops
 * answering, and so an invited reviewer's agent can fetch the text it quotes in
 * a comment. The owner's behaviour is unchanged; a reader is anyone `canRead`
 * (`CAN_READ_SQL`) allows, and everyone else, a deleted document included, is `404`.
 * A browser cannot reach this: it needs a bearer header, and the sandbox says so
 * anyway.
 */
async function storedHtml(env: Env, publisher: Publisher, docId: string): Promise<Response> {
  if (!isDocId(docId)) return docNotFound(docId);
  const found = await findReadableDoc(env.DB, docId, null, publisher.owner);
  if (found === null || found.deleted_at !== null || !found.allowed) return docNotFound(docId);
  const object = found.version ? await env.DOCS.get(versionObjectKey(docId, found.version)) : null;
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
  const grant = await grantUrl(env, found.owner, { docId, pinned: null }, publisher.owner, now, found.origin_code);
  return grant
    ? Response.json(grant, { headers: NO_STORE })
    : errorResponse("not_found", "No API route for this request.");
}
