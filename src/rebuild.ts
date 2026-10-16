/**
 * Rebuild the document rows of D1 from R2: the manifest for the state, the
 * version objects for the version log.
 *
 * Pure, with no Worker imports, so an operator script can run it under plain
 * Node (`scripts/rebuild-d1.mjs`). The procedure is in docs/deploying.md.
 *
 * **Fail closed.** Whatever a manifest cannot vouch for is read in the
 * direction that exposes least: an unknown or missing `linkAccess` is
 * `invited`, an unknown role is `view`, and a prefix with no readable manifest
 * becomes a private doc with no owner, which nobody can read until an operator
 * assigns one by hand. A rebuild can therefore hide a document that should be
 * public; it cannot publish one that should be private.
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

/**
 * The rows for one doc. `docId` comes from the prefix the objects were listed
 * under and is trusted over the manifest's own copy. `manifest` is what parsed
 * from `manifest.json`, or null when there is none.
 */
export function rowsFromManifest(
  docId: string,
  manifest: Partial<DocManifest> | null,
  objects: readonly ListedObject[],
): RebuiltRows {
  const m = manifest ?? {};

  const versions = objects.flatMap((object) => {
    const match = /^v([1-9][0-9]*)\.html$/.exec(object.key.slice(`docs/${docId}/`.length));
    return match ? [{ doc_id: docId, n: Number(match[1]), size: object.size, title: null, created_at: object.uploaded }] : [];
  });

  const created = m.createdAt ?? 0;
  return {
    doc: {
      id: docId,
      owner: m.owner ?? "",
      title: m.title ?? "Untitled",
      latest_version: Math.max(m.latestVersion ?? 0, ...versions.map((v) => v.n)),
      created_at: created,
      updated_at: m.updatedAt ?? created,
      deleted_at: m.deletedAt ?? null,
      link_access: m.linkAccess === "anyone" ? "anyone" : "invited",
      comments_enabled: m.commentsEnabled === true ? 1 : 0,
    },
    invites: (m.people ?? []).map((person) => ({
      doc_id: docId,
      email: person.email,
      role: person.role === "comment" ? "comment" : "view",
      created_at: person.createdAt ?? 0,
    })),
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
