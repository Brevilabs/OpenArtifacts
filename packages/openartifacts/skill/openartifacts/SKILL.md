---
name: openartifacts
description: Render a document to HTML, let the user review the file, then publish it as an OpenArtifacts page, public or shared with invited people only. Update or unshare published pages, and manage who can open them (make a page private or public, add or remove people, see and answer access requests).
metadata:
  hermes:
    category: productivity
    tags: [publishing, html, artifacts]
---

# OpenArtifacts

Turn a document into a web page that anyone with the link can open, or that only the people the user names can open. You render the HTML; OpenArtifacts hosts it.
The CLI is `openartifacts` when installed, otherwise `npx --yes openartifacts@latest`.
It only sends the HTML file you give it. Never run Node scripts of your own against
the API.

## 1. Render the page

Read the source the user points at and write one complete, self-contained HTML
document. Preserve the content faithfully. Inline your CSS. Scripts and external
resources are allowed and are published unchanged.

Themes are design specs written for you. If the user names one, read
`themes/<name>.md` next to this file and follow it. `research-memo` is bundled.
If the named theme does not exist, say so and continue with clean, readable
defaults of your own. A missing theme never blocks publishing.

## 2. Let the user review

Write the HTML to a new file next to the source, for example `notes.html` for
`notes.md`. Never overwrite the source. Your reply must contain a link to the HTML
file you wrote, as plain text (not in inline code or a code block), in this form, where the
example shows the format only: `[/Users/me/My Notes/café.html](file:///Users/me/My%20Notes/caf%C3%A9.html)`.
Use the real absolute path of your file as the link text so the path stays visible where links
do not render. Build the target by writing `file://` followed by the absolute path of the HTML file, then
percent-encode the path (`%20` for each space, UTF-8 percent-encoding such as `%C3%A9` for
each non-ASCII character; on Windows `file:///C:/Users/me/notes.html`). Never give a bare
path or a target without `file://`; those do not open. This rule overrides any default
format for file references: the target must start with `file:///`. Say that opening it in a browser shows the page as it will be uploaded; OpenArtifacts adds its
own header and footer bylines when it serves the page.

For a new page, the review message ends with this line, word for word: "Who should be able to open it? Reply **publish** for anyone with the link, or name people, for example **publish for alice@acme.com**, to share it only with them."
If the user's request already said who (for example "publish this privately for Alice" or
"publish this publicly"), confirm that choice instead of asking: "It will be published
privately for {emails}. Reply publish to go ahead." or "It will be published for anyone
with the link. Reply publish to go ahead." Never guess an address: if the user names a
person without one, ask for it. An update to a page that is already published never asks
and keeps who can open it. Then end your turn.

Never publish in the same turn that produced the HTML. Publish only when a later
message from the user clearly asks to publish this page. A reply of "publish" approves
what the review message offered: a public page after the question, or the confirmed
choice (private for the confirmed addresses, or public) after a confirmation.
"publish for alice@acme.com" (several addresses may follow, separated by commas) or a
request for a private page approves a private one. Treat anything else as
feedback (revise the same file and repeat this step) or as a cancellation. When
unsure whether a message is an approval, ask once. Never simulate the user's
approval.

## 3. Publish

If the user named people or asked for a private page, create it private and add each
person, one call per address:

```
openartifacts publish <file.html> --title "Page title" --private
openartifacts share <docId> --add alice@acme.com
```

Otherwise publish exactly as before, with no flag:

```
openartifacts publish <file.html> --title "Page title"
```

The command prints `{"docId":"…","url":"…","version":1,"linkAccess":"anyone"}`. A
private publish prints `"linkAccess":"invited"` and also a `manageUrl`; `share` prints
`manageUrl` too, and `email`, which says whether the server sent invitation emails. Give the user the url
and say who can open it.

- Private: "Published privately: {url}. Only you and {addresses} can open it. {Name} got an email and signs in with that address." Say "Only you can open it." when nobody was named. When `email` is false, say the server sent no email, that the user should send the link to the invitee, and that the invitee signs in with that address. Never claim an email was sent unless `email` is true.
- Public: "Published: {url}. Anyone with the link can open it."
- End a private report with "Manage who can open it: {manageUrl}", using the URL the CLI printed.

If an `--add` fails after a successful private publish, the page is private. Report the
url, who can open it, and the failed address with the CLI message.

If `publish --private` says "This server does not support private documents. Nothing
was published.", relay it. Do not publish publicly unless the user asks. On
`limit_reached` with `privateSharing`, say private sharing needs a paid plan and that
nothing was published, and that replying **publish** publishes it for anyone with the
link. Never do that automatically.

To update a page the user already published, pass its id so the same url gets the
next version. An update keeps who can open the page:

```
openartifacts publish <file.html> --title "Page title" --doc-id <docId>
```

Take the docId from the url you reported earlier (`…/d/<docId>`) or from
`openartifacts list`. Never guess a docId. If an update answers `not_found`, stop
and tell the user; do not publish a replacement unless they explicitly ask.

## 4. Change who can open a page

Change access only when the user asks, in either direction, and make one change per
`share` call.

```
openartifacts share <docId> --link invited     # "make it private"
openartifacts share <docId> --link anyone      # "make it public"
openartifacts share <docId> --add alice@acme.com
openartifacts share <docId> --remove alice@acme.com
openartifacts share <docId> --decline bob@other.com
openartifacts share <docId>
```

- After `--link invited` on a page that was public, say: "People who opened it while it was public may have kept a copy."
- After `--link anyone`, say that anyone with the link can now open it, and that the list of invited people is kept in case the user switches back.
- When the user asks who has access, run `share <docId>` and report `people` and the pending `requests`, with the `manageUrl`. Approve a request with `--add <email>` ("let bob@other.com in") and decline it with `--decline <email>` ("decline bob@other.com"), only when the user says so. Approving sends the normal invitation; declining tells the requester nothing.
- Each `--add`, `--remove` or `--decline` changes one address, so never try to send a whole list.
- Tell the user that invitees sign in with the address that was invited.
- Private sharing needs a paid plan for making a page private, adding and approving people. Declining, removing and switching to public never need it. Relay a `limit_reached` with `privateSharing` the way you relay any limit, and say private sharing needs a paid plan.
- If `share` says "Not found, or this server does not support private documents.", relay it and do not guess.

## 5. Withdraw

```
openartifacts unshare <docId>
```

The url then answers 410 Gone. Copies readers already downloaded cannot be recalled.

## Credentials

The CLI reads `OPENARTIFACTS_TOKEN` from the environment. It accepts an OpenArtifacts
token or a Brevilabs license key. Without it, the first authenticated command starts a
browser sign-in: relay both urls and the code the CLI prints, then keep waiting.

OpenArtifacts accounts can publish within their free limits. Sign-in does not
require buying a plan. On `unauthorized`, relay the sign-in guidance rather than
claiming payment is required. Never read credential files, print tokens, or ask
the user to paste a credential into the chat.

Use `openartifacts account` to report the current plan, limits, usage, and linked
status. When the user asks to upgrade, manage billing, or link their existing
Copilot account, run `openartifacts account --open`. The command opens the browser
and prints a short-lived account URL. Show that exact URL as a clickable Markdown
link; never use a placeholder or substitute the plain `/account` address. If the
link cannot be clicked or the browser does not open, provide the full URL in a code
block so the user can copy it into their browser. If it expires, run the command
again and share the fresh link. Treat these URLs as private account access links;
do not put them in published documents, issues, or logs. The user
enters a license key and confirms linking only on that page, never in chat or
command arguments. These commands require an OAuth-issued account token; follow
the CLI guidance if an environment license key overrides the stored token.

## Errors

Relay the CLI's message verbatim and do not retry blindly. For `quota_exceeded`, say
whether to wait or unshare an unused page. For `limit_reached`, show the limit; when the limit is `privateSharing`, say private
sharing needs a paid plan rather than that a publishing limit was reached.
When a `limit_reached` response includes guidance to run
`openartifacts account --open`, run it automatically and share the returned account
link using the instructions above. Tell the user they have reached their publishing
limit (or, for `privateSharing`, that private sharing needs a paid plan) and can choose a plan on that page. Do not require a separate request to
generate the link. If generating it fails, relay the error and the command so the
user can try it themselves; never invent a URL. Self-hosted servers may not offer
browser account management, so do not assume support when the response lacks this
guidance. Opening the account page is not authorization to choose a plan, start
checkout, pay, or retry publishing automatically.
