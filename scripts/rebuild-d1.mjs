// Turn a local mirror of the bucket into SQL that rebuilds the document rows of
// D1 (docs, doc_invites, versions, storage_usage). Usage:
//
//   node scripts/rebuild-d1.mjs <mirror-dir> > rebuild.sql
//
// <mirror-dir> holds `docs/{docId}/...` exactly as the bucket does, copied with
// a tool that keeps each object's last-modified time (rclone and `aws s3 sync`
// both do): that time becomes the version's created_at. Runs on Node 22.18+,
// which strips the types from src/rebuild.ts itself. See docs/deploying.md.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { rebuildSql, rowsFromManifest } from "../src/rebuild.ts";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/rebuild-d1.mjs <mirror-dir>");
  process.exit(2);
}

const rebuilt = [];
let unreadable = 0;
for (const docId of readdirSync(join(root, "docs")).sort()) {
  const dir = join(root, "docs", docId);
  const objects = readdirSync(dir).map((name) => {
    const stat = statSync(join(dir, name));
    return { key: `docs/${docId}/${name}`, size: stat.size, uploaded: Math.round(stat.mtimeMs) };
  });
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    unreadable++;
    console.error(`no readable manifest for ${docId}: it will be private with no owner`);
  }
  rebuilt.push(rowsFromManifest(docId, manifest, objects));
}
console.error(`${rebuilt.length} documents, ${unreadable} without a manifest`);
process.stdout.write(rebuildSql(rebuilt));
