/**
 * Rebuild the document rows of D1 from R2: the manifest for the state, the
 * version objects for the version log.
 *
 * Pure, with no Worker imports, so an operator script can run it under plain
 * Node (`scripts/rebuild-d1.mjs`). The procedure is in docs/deploying.md.
 *
 * **Fail closed.** Whatever a manifest cannot vouch for is read in the
 * direction that exposes least: an unknown or missing `linkAccess` is
 * `invited`, an unknown role is `view`, a malformed `deletedAt` counts as
 * deleted, and a prefix with no readable manifest becomes a private doc with no
 * owner, which nobody can read until an operator assigns one by hand. A rebuild
 * can therefore hide a document that should be public; it cannot publish one
 * that should be private.
 *
 * Scope: document state only (`docs`, `doc_invites`, `versions`, and the
 * `storage_usage` ledger rows that mirror `versions`). Accounts, sessions,
 * owner links, publishers, access requests and comments are not in R2.
 */
import type { DocManifest } from "./manifest.js";

/** What R2 reports for one object under the doc's prefix. `uploaded` is epoch ms. */
export interface ListedObject {
  key: string;
  size: number;
  uploaded: number;
}

export interface RebuiltRows {
  doc: {
    id: string;
    owner: string;
    title: string;
    latest_version: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    link_access: "anyone" | "invited";
    comments_enabled: 0 | 1;
  };
  invites: Array<{ doc_id: string; email: string; role: "view" | "comment"; created_at: number }>;
  versions: Array<{ doc_id: string; n: number; size: number; title: null; created_at: number }>;
}

const DEFAULT_TITLE = "Untitled";

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The rows for one doc. `docId` comes from the prefix the objects were listed
 * under and is trusted over the manifest's own copy. `manifest` is whatever
 * parsed from `manifest.json`, or null when there is none.
 */
export function rowsFromManifest(
  docId: string,
  manifest: unknown,
  objects: readonly ListedObject[],
): RebuiltRows {
  const m: Partial<Record<keyof DocManifest, unknown>> =
    manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : {};
  const prefix = `docs/${docId}/`;

  const versions = objects.flatMap((object) => {
    if (!object.key.startsWith(prefix)) return [];
    const match = /^v([1-9][0-9]*)\.html$/.exec(object.key.slice(prefix.length));
    if (!match) return [];
    return [{ doc_id: docId, n: Number(match[1]), size: object.size, title: null, created_at: object.uploaded }];
  });
  versions.sort((a, b) => a.n - b.n);

  const highest = versions.at(-1)?.n ?? 0;
  const counter = typeof m.latestVersion === "number" && Number.isSafeInteger(m.latestVersion) ? m.latestVersion : 0;
  const firstSeen = versions.reduce((least, v) => Math.min(least, v.created_at), Infinity);
  const created = isTime(m.createdAt) ? m.createdAt : Number.isFinite(firstSeen) ? firstSeen : 0;

  // Absent or null is live. A present value that is not a time is not trusted to mean live.
  const deleted = m.deletedAt === undefined || m.deletedAt === null ? null : isTime(m.deletedAt) ? m.deletedAt : 0;

  const people = Array.isArray(m.people) ? m.people : [];
  const seen = new Set<string>();
  const invites = people.flatMap((person: unknown) => {
    if (person === null || typeof person !== "object") return [];
    const { email, role, createdAt } = person as Record<string, unknown>;
    if (typeof email !== "string" || email === "" || seen.has(email)) return [];
    seen.add(email);
    return [{
      doc_id: docId,
      email,
      role: role === "comment" ? ("comment" as const) : ("view" as const),
      created_at: isTime(createdAt) ? createdAt : 0,
    }];
  });

  return {
    doc: {
      id: docId,
      owner: typeof m.owner === "string" ? m.owner : "",
      title: typeof m.title === "string" ? m.title : DEFAULT_TITLE,
      latest_version: Math.max(counter, highest),
      created_at: created,
      updated_at: isTime(m.updatedAt) ? m.updatedAt : created,
      deleted_at: deleted,
      link_access: m.linkAccess === "anyone" ? "anyone" : "invited",
      comments_enabled: m.commentsEnabled === true ? 1 : 0,
    },
    invites,
    versions,
  };
}

const quote = (value: string | number | null): string =>
  value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;

const insert = (table: string, columns: string[], values: Array<string | number | null>): string =>
  `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${values.map(quote).join(", ")});`;

/**
 * SQL for `wrangler d1 execute --file`. `OR IGNORE`, so running it over a
 * database that still holds some rows never overwrites what D1 already says
 * with an older snapshot. Parents come before children.
 */
export function rebuildSql(rebuilt: readonly RebuiltRows[]): string {
  const lines: string[] = [];
  for (const { doc, invites, versions } of rebuilt) {
    lines.push(insert("docs", Object.keys(doc), Object.values(doc)));
    for (const invite of invites) lines.push(insert("doc_invites", Object.keys(invite), Object.values(invite)));
    for (const version of versions) {
      lines.push(insert("versions", Object.keys(version), Object.values(version)));
      if (version.size > 0) {
        lines.push(insert("storage_usage", ["doc_id", "n", "size"], [version.doc_id, version.n, version.size]));
      }
    }
  }
  return lines.join("\n") + "\n";
}
