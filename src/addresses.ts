/**
 * The addresses in what an owner pasted into "Add people".
 *
 * Commas, semicolons, whitespace and newlines separate; `Name <a@x.com>`, as a
 * mail client copies it, yields `a@x.com`; duplicates collapse ignoring case.
 * A token with no `@` between two non-empty halves goes to `bad`, to be
 * reported rather than sent. That is only sorting: whether an address is
 * acceptable stays `addPerson`'s decision.
 *
 * **The Share popover carries a copy of this in `FRAME_SCRIPT`**, because the
 * frame cannot import. Change both together; `test/addresses.test.ts` runs both.
 */
export function parseAddresses(text: string): { emails: string[]; bad: string[] } {
  const emails: string[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  // The frame's copy cannot use a backslash, so both build the classes from char
  // codes (tab, line breaks, space, no-break space) and stay identical.
  const gap = String.fromCharCode(9, 10, 11, 12, 13, 32, 160);
  // A name starts at a token boundary, so it cannot cut the end off the address before it.
  const named = new RegExp('(?<![^,;' + gap + '])(?:"[^"]*"[' + gap + ']*|[^<>,;"@' + String.fromCharCode(10) + ']*)<([^<>]*)>', "g");
  for (const token of text.replace(named, " $1 ").split(new RegExp("[,;" + gap + "]+"))) {
    const key = token.toLowerCase();
    if (token === "" || seen.has(key)) continue;
    seen.add(key);
    if (/^[^@]+@[^@]+$/.test(token)) emails.push(key);
    else bad.push(token);
  }
  return { emails, bad };
}
