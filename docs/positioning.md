# Agent-First Docs - Product Positioning

> Definition (Logan): **"a new shared info artifact where humans and agents comment and iterate together to converge to a consensus."**

Research basis: [[Deep Research Report - Agent-Native Markdown Doc Sharing]] (23 products, capability claims verified against first-party API specs and source code, 2026-07-14). Scope note: "none" or "no product" below always means none of the 23 surveyed.

## The central hypothesis

**Humans and agents are both first-class citizens on the doc: either can read, comment, reply, and resolve, and the human path (highlight text, type a comment in the browser) is fully supported, never a fallback.** The hypothesis is about where the center of gravity goes: **over time, most interaction will flow through the agent.** People will increasingly talk to their agent about the doc, possibly by voice, and the agent reads, summarizes, drafts anchored comments, replies, and resolves on their behalf, with the human approving what goes out in their name.

The product must be complete for both modes from day one. That symmetry is the differentiator: surveyed products are polished for the human mode, while their agent mode is missing or fragile (detail below), and none treats the agent as a collaborator with its own identity and approval semantics. The hypothesis tells us which mode to optimize hardest, and it is a bet, listed first under falsifiers.

## What follows from the hypothesis

1. **Two full front doors, built with equal rigor.** The webpage is a complete client for humans (read, highlight, comment, resolve); MCP/API is a complete client for agents. No surveyed product builds the second with the seriousness of the first; we build both.
2. **Pending comments are the core primitive of the agent mode.** A human-typed comment posts directly. An agent-drafted comment posts as pending, attributed agent-for-human, and becomes visible to others on the human's approval. Approval must be batchable (otacon's "one clean revision" pattern applied to comments) or the friction removed from writing returns as moderation.
3. **Delegated identity is structural, not cosmetic.** Every comment carries who wrote it: a human directly, or an agent proposing and a human approving. The consensus at the end is between humans, however it was reached.
4. **The doc URL is a context packet.** Because agents are full participants, agent-to-agent handoff is the same primitive: one URL carries full content plus nuanced discussion threads.
5. **Surveyed products serve the agent mode poorly, in a specific verified way.** The two biggest (Notion, Google Docs) cannot create a text-range-anchored comment through their public APIs at all. The APIs that can (Outline, Confluence Cloud, BookStack, Docmost) lose or dangle those anchors when the document body is rewritten, which is precisely the operation an agent performs on every iteration. And none of the 23 offers agent identity or a pending-approval lifecycle.

## Product shape

Shared HTML docs on our site. The sharer pushes a local md or html file; the site always serves HTML; each push mints a version.

- **One artifact, two native readings**: agents parse the same HTML (content, anchors, threads as markup) that humans see rendered. No lossy projection between agent surface and human surface.
- **The push is content; the read is composed.** The server re-anchors carried-forward threads on each push. Re-anchoring across rewrites is unsolved among the surveyed products (verified: Outline's default replace mode orphans every anchor and its patch mode preserves marks only outside the edited span; an open, verified bug report shows Confluence Cloud API page updates leave inline comments dangling even when the anchored text is untouched). Concentrating it at one choke point we own makes it the core engineering asset.
- **Anchors are quotes, not positions** (TextQuoteSelector-style, fuzzy re-anchor on push, orphaning visible). Comments belong to the version they were made on; resolve cites the version that addressed it. The review log falls out of the storage model.
- **Human-readable diffs between versions.** Any two pushes can be compared as a rendered-prose diff, so a returning reviewer sees what changed since they last looked instead of re-reading the doc. This is otacon's revision-diff pattern made multiplayer, and it inverts GitHub's weakness: GitHub has diffs without commentable rendered prose; we render the prose and diff it. Together with resolve-cites-version, the diff view is where "iterate with a clear track" becomes visible.
- **HTML carries what sanitized markdown pipelines strip**: interactive figures, embedded simulations, Litt-style explainers and microworlds.
- **Unit of sharing is one note page** plus a per-user "my docs" index. (Obsidian Publish publishes selected notes as one site with at most a single site-wide password; here each doc is an independent unit with its own audience.)
- **Sharing is an API primitive**: public link, or a list of emails, read or read-write per grantee, settable by the agent.
- **Posture**: standalone, lightweight, open-flag service for local md/html artifacts (Obsidian first), against closed ecosystems. Not a Copilot feature; Copilot integrates via right-click share and stays lean.

## Why nobody serves this today

No surveyed product closes the loop this product needs: rewrite-durable anchors + resolve + hosting + programmatic sharing + agent identity.

- **Nearest existing product: Outline** (markdown CRUD, anchored comments, resolve, sharing API, official MCP). Its verified gaps: resolve exists in server code but not in the published API contract; inline-comment creation requires collaborative editor state (a doc created via API can refuse inline comments until opened in a browser); a whole-document replace destroys every anchor; collaborators are workspace members in a wiki, not invitees to one page; no delegated identity or pending comments.
- **Notion / Google Docs** (the defaults people assume): Notion's public API cannot create a text-range-anchored discussion (block-level only), cannot resolve, cannot read resolved threads, and exposes no sharing or permission endpoints; its official MCP inherits all of it. Google's Drive API stores the anchor you send, and the Workspace editors render the comment as unanchored.
- **Hypothes.is**: the best anchoring surveyed (W3C quote selectors, fuzzy re-anchoring across edits) with no resolve state and no doc hosting.
- **GitHub PRs**: agent-native, threaded, resolvable, and closest on provenance (threads marked outdated by later commits). But review comments attach to source diff lines; the rendered markdown preview is not commentable, and repo HTML files display as source. There is no way to leave an anchored comment on rendered prose, and non-technical reviewers won't work in PRs.

None of the 23 links a resolved thread on a rendered document to the revision that resolved it, and none attributes actions as agent-for-human.

## Demand evidence

- At least four independent community MCP servers exist just to bolt agent access onto Docmost; Zero rigged phone review of agent output with Hermes and a Cloudflare Worker. When users hand-build a thing, the thing is real.
- Notion's own engineers pipe agent-written explainer docs into Notion for anchored team discussion (Litt), yet the agent that wrote the doc cannot join that discussion: the public API can't create a text-range thread, can't resolve one, and can't read resolved ones.
- Adoption and agent capability don't line up: the most-starred OSS product (AFFiNE, 70k) can't run this loop through its public API at all; the biggest SaaS (Notion, 100M+ users) fails every leg beyond CRUD and replies; the most capable APIs sit mid-pack (Outline, ~40k) or niche (BookStack ~19k, Hypothes.is ~3k stars, 40M+ annotations). The collaboration surface wins markets; the agent-capable products never built one.

## Proof points

- **otacon** ([repo](https://github.com/zeroliu/otacon)): the single-player prototype. Agent drafts, human reviews rendered HTML in a browser, inline comments on any selected passage route back to the agent, revisions diff, approve gates action. In real use it demonstrates the medium (HTML with anchored comments) and the interaction pattern this product generalizes (agent proposes, human approves, then it is real). Delta: otacon is 1 human, 1 agent, 1 machine, ephemeral; this product is N humans + N agents, hosted, persistent, symmetric.
- **Notion / Geoffrey Litt** ([[2026-07-10-understanding-is-the-new-bottleneck-geoffrey-litt-notion]]): an incumbent evangelizing shared human-agent spaces, cognitive debt, explainer docs, while its public API cannot create a text-range comment, resolve one, or share a page. The gulf between the vision their staff preaches and what their platform permits is the market. Counter-frame (Logan): Notion moving here is a follow signal, not a deterrent, the way Obsidian Copilot thrives alongside Notion AI; an open product for local md/html users is an audience Notion's walls can't reach.

## Adoption wedge

Zero's challenge: lightweight only works if the product solves a clear problem for a clear person. The wedge, each step pulling the next:

1. **Share**: push any local md/html, get a beautiful hosted HTML page with a private link. Solves phone review of agent output today (Zero's felt pain; right-click share in Obsidian).
2. **Comment**: once shared, comments are the natural ask. Both paths from the start: highlight-and-type in the browser, or talk to your agent and approve the threads it drafts.
3. **Converge**: multiplayer humans + agents iterating to consensus with version history and resolve-provenance. The full thesis.

Step 1 must stand alone as a good product; steps 2 and 3 are why it wins.

## Unfair advantages

1. **Obsidian Copilot as distribution**: right-click share reaches exactly the audience that keeps notes in markdown and already runs agents.
2. **miyo future voice bridge** ([[Miyo Workflows - Product Strategy]]): if the hypothesis holds, voice is a front door, hear the doc, react out loud, approve drafted comments from the phone. Same worldview, adjacent surface.
3. **Timing**: the enabling stack (MCP with OAuth, mainstream agent CLIs) matured within the last 12-18 months; surveyed products are adding agent access without repositioning around it.

## Risks and falsifiers

- **The central hypothesis is the biggest bet, but a hedged one.** If gravity stays with humans typing comments, the product still works (the human mode is complete); the cost is misallocated optimization, not product failure. Watch the agent-vs-human comment ratio in wedge steps 1-to-2 before investing deep in the agent mode.
- **Approval fatigue** in the agent mode: reviewing the doc plus reviewing your agent's drafts is two queues. Batch approval is the mitigation; if it still feels like work, the interaction model needs rethinking.
- **Outline closing its gaps**: it is the nearest product and ships fast (anchored comments May 2026, MCP patch support Apr 2026). Documenting resolve, preserving anchors across rewrites, and per-doc guest sharing would make it the incumbent to beat.
- **Notion closing the gap**: text-range-anchored comments + resolve in their public API/MCP, or a sharing endpoint, would turn this into a speed-and-distribution race. Top external falsifier.
- **First-problem clarity** (Zero's objection): unresolved until wedge step 1 ships and someone besides us reaches for it daily.
- **Lightweight under limited resources**: 轻量化、好用 is the execution constraint; scope discipline is the moat's precondition.
- **GitHub sufficiency** for all-technical teams; the wedge audience is mixed teams.
- **Thin feature moat**: the durable assets are the re-anchoring engine, the provenance data model, and the human-agent network on shared docs.

## What would prove the thesis

- 5 to 10 design partners who run Claude Code or Codex daily and share prose with mixed-technical reviewers.
- The 90-second demo: publish an Obsidian note; one reviewer highlights and types a comment in the browser, another talks to their agent (ideally voice, from a phone) and approves the threads it drafted; the author's agent triages, re-pushes a revision; threads resolve citing the diff. If watchers ask "can I use this today," both the paradigm claim and the central hypothesis hold.
- Open design question for the spec phase: do agents read threads by parsing the served HTML or via a structured endpoint alongside it (parsing burden vs API surface).

---

*Derived from [[Deep Research Report - Agent-Native Markdown Doc Sharing]], the Litt capture, and the Logan-Zero Discord debate, 2026-07-14. Capability statements are scoped to the 23 surveyed products and their verified API behavior as of that date; this space shipped major changes in H1 2026 and claims will age.*
