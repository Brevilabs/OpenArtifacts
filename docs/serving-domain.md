# Why user content gets its own domain

**The rule: `symposium.md` is the brand. `symposium.site` serves the documents.
Nothing a user uploaded is ever served from `symposium.md`.**

This is listed as a non-negotiable constraint in [`CLAUDE.md`](../CLAUDE.md), and
it is the kind of decision that looks like premature caution right up until the
morning it is not. This doc is why it holds.

[← README](../README.md) · [Hosting](hosting.md) · [Cost at scale](cost-at-scale.md)

## What we are actually protecting against

Symposium serves arbitrary user-uploaded HTML with scripts enabled. That is not
a compromise, it is the product — interactive figures and embedded simulations
are the reason the client uploads HTML instead of markdown
([http-api.md](http-api.md)). It also happens to be the exact profile that
Google Safe Browsing and Microsoft SmartScreen exist to detect.

One publisher uploading one convincing login page is enough. When the domain gets
listed, Chrome, Edge, Firefox and Safari put a full-page red interstitial in front
of **every url on it** — the marketing site, the docs, the pricing page, the
signup, and every document anyone has ever shared. Gmail and Slack start
rewriting or blocking the links. Delisting is a review request that takes days,
and a domain with a history gets flagged faster and cleared slower the second
time.

Splitting the domains does not prevent any of that. It decides which domain
absorbs it. A flagged `symposium.site` is a bad week for document serving. A
flagged `symposium.md` is a bad week for the company.

## Why a subdomain does not work

`docs.symposium.md` buys nothing. Reputation systems operate on the registrable
domain — the eTLD+1 — so a listing against a subdomain lands on the parent.
Cookies and CSP have the same problem in the other direction: same-site
protections treat a subdomain as related, which is precisely what you do not want
between a page you wrote and a page a stranger uploaded.

The pattern is well settled among everyone who has been burned:

| Product | Brand | User content |
|---|---|---|
| Notion | `notion.so` | `notion.site` |
| Google | `google.com` | `googleusercontent.com` |
| GitHub | `github.com` | `githubusercontent.com`, `github.io` |
| Glitch | `glitch.com` | `glitch.me` |

Note what these have in common: the serving domain is still obviously the brand.
Separation costs nothing in recognition. A reader landing on
`symposium.site/d/abc` knows exactly whose product they are looking at.

## Why it cannot be fixed later

This is the part that makes it urgent rather than merely correct.

Every published url is permanent by design. Pinned `/v{n}` urls are served
`immutable` with a one-year lifetime, and shared links live in other people's
notes, chats and emails where we cannot reach them. **There is no migration path
for a serving domain.** Moving it later means either breaking every link ever
shared, or serving both domains forever and keeping the exposure we were trying
to shed.

So the cost of doing it now is one domain registration. The cost of doing it
later is that it cannot be done.

## What the paid publishing gate does and does not do

Publishing requires payment ([cost-at-scale.md](cost-at-scale.md) §8), and that
helps more than it looks like it should. A card on file and a real charge deter
casual abuse, make each bad actor traceable, and give us an account to terminate.
Expect the incident rate to be low.

It does not change the decision, for one reason: the blast radius of a single
incident is unchanged. $2.99 is not a deterrent to someone running a phishing
campaign, and the domain gets listed on the first bad document, not the
hundredth. A gate that lowers frequency does not help when the thing you are
insuring against is one occurrence.

## Status

**Both domains are registered as of 2026-07-25** — `symposium.md` for the brand,
`symposium.site` for documents — and both are delegated to Cloudflare. Neither is
attached to the Worker yet, so nothing is reachable: `workers_dev` is `false`
precisely because the path-prefix fallback would otherwise serve `/d/*` on a
`workers.dev` url, which is the mistake this whole document argues against. The
fallback stays in the router for the window where one host var is set and the
other is not.

Three things become true together when the real domains land, and
[`CLAUDE.md`](../CLAUDE.md) carries the detail:

1. **Set `SERVING_HOST` and `API_HOST`.** The router resolves surface by host
   first and only falls back to path prefixes while both are empty. Leaving them
   unset means `/api/v1` stays reachable on the serving domain, which defeats the
   split.
2. **Add a Cache Rule.** Cloudflare does not cache HTML by default, and `/d/{docId}`
   has no file extension, so attaching a domain alone changes nothing.
3. **Purge on delete, in the same change.** Once there is an edge cache, an
   unshared doc keeps being served from it. Shipping caching without purging is
   how a withdrawn document stays readable.

## What changes when reading stops being anonymous

The argument above rests on the serving origin being cookieless, which is also
what lets uploaded documents run scripts. Private sharing breaks that, and the
way out is to keep identity on the brand domain and grant access per document
rather than by session — and that is not sufficient on its own. A hostile public
document can `window.open` a private one and read the grant off the popup once it
returns to this origin, so isolating documents from each other is a prerequisite,
not an enhancement. It is nearly free to adopt now and effectively impossible
once readers hold private links.
[private-sharing.md](private-sharing.md) has the reasoning and the phases.
