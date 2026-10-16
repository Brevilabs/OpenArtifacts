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
 * Apply the result to an empty database only (see `rebuildSql`).
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

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => Number.isSafeInteger(value);

/** Exactly the shape `writeManifest` emits; `docId` is ignored, the prefix is trusted. */
export function readable(manifest: unknown): manifest is DocManifest {
  if (typeof manifest !== "object" || manifest === null) return false;
  const m = manifest as Record<string, unknown>;
  return (
    m.schema === 1 &&
    isString(m.owner) &&
    isString(m.title) &&
    isString(m.linkAccess) &&
    typeof m.commentsEnabled === "boolean" &&
    isNumber(m.createdAt) &&
    isNumber(m.updatedAt) &&
    isNumber(m.latestVersion) &&
    (m.deletedAt === null || isNumber(m.deletedAt)) &&
    Array.isArray(m.people) &&
    m.people.every(
      (person) =>
        typeof person === "object" && person !== null && isString(person.email) && isString(person.role) && isNumber(person.createdAt),
    )
  );
}

/** What a prefix with no readable manifest rebuilds as: private, with no owner. */
const CLOSED: Omit<DocManifest, "schema" | "docId"> = {
  owner: "",
  title: "Untitled",
  linkAccess: "invited",
  commentsEnabled: false,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  latestVersion: 0,
  people: [],
};

/**
 * The rows for one doc. `docId` comes from the prefix the objects were listed
 * under and is trusted over the manifest's own copy. `manifest` is what parsed
 * from `manifest.json`, or null when there is none. Unless it has exactly the
 * shape `writeManifest` emits (`readable`), it is unreadable and the doc
 * rebuilds closed, so a format written by a newer version, or a damaged
 * manifest, never half-applies.
 */
export function rowsFromManifest(docId: string, manifest: unknown, objects: readonly ListedObject[]): RebuiltRows {
  const m = readable(manifest) ? manifest : CLOSED;

  const versions = objects.flatMap((object) => {
    const match = /^v([1-9][0-9]*)\.html$/.exec(object.key.slice(`docs/${docId}/`.length));
    return match ? [{ doc_id: docId, n: Number(match[1]), size: object.size, title: null, created_at: object.uploaded }] : [];
  });

  return {
    doc: {
      id: docId,
      owner: m.owner,
      title: m.title,
      latest_version: Math.max(m.latestVersion, ...versions.map((v) => v.n)),
      created_at: m.createdAt,
      updated_at: m.updatedAt,
      deleted_at: m.deletedAt,
      link_access: m.linkAccess === "anyone" ? "anyone" : "invited",
      comments_enabled: m.commentsEnabled ? 1 : 0,
    },
    invites: m.people.map((person) => ({
      doc_id: docId,
      email: person.email,
      role: person.role === "comment" ? "comment" : "view",
      created_at: person.createdAt,
    })),
    versions,
  };
}

/**
 * A SQL literal. A raw newline never appears in it: `D1Database.exec` splits
 * its input on newlines, so a title with one in it would be cut in half, and
 * SQLite ends the statement at a NUL. They are spliced in as `char(10)` /
 * `char(13)` / `char(0)` instead, which round-trips the value exactly and
 * reads the same through `wrangler d1 execute --file`.
 */
const quote = (value: string | number | null): string => {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return value
    .split(/(\r|\n|\0)/)
    .filter((part) => part !== "")
    .map((part) => (part === "\n" ? "char(10)" : part === "\r" ? "char(13)" : part === "\0" ? "char(0)" : `'${part.replaceAll("'", "''")}'`))
    .join(" || ") || "''";
};

const insert = (table: string, columns: string[], values: Array<string | number | null>): string =>
  `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.map(quote).join(", ")});`;

/**
 * SQL for `wrangler d1 execute --file`. Apply it to an empty database: the
 * rebuild is for a lost D1, and a partial loss is restored with D1 Time Travel,
 * not with this. Plain `INSERT`, so a non-empty database fails instead of
 * merging a stale snapshot into live rows (an invite removed since the
 * manifest was written would come back and regain access). Parents come before
 * children, so a row that already exists fails on the first statement.
 */
export function rebuildSql(rebuilt: readonly RebuiltRows[]): string {
  const lines: string[] = [];
  for (const { doc, invites, versions } of rebuilt) {
    lines.push(insert("docs", Object.keys(doc), Object.values(doc)));
    for (const invite of invites) lines.push(insert("doc_invites", Object.keys(invite), Object.values(invite)));
    for (const version of versions) lines.push(insert("versions", Object.keys(version), Object.values(version)));
  }
  // The quota ledger mirrors `versions`, as migrations/0013 builds it.
  lines.push("INSERT INTO storage_usage (doc_id, n, size) SELECT doc_id, n, size FROM versions WHERE size > 0;");
  return lines.join("\n") + "\n";
}
