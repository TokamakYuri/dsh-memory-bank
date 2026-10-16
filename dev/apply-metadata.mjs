// Apply the publication metadata to package.json.
//
// The manifest is rewritten through `JSON.stringify`, never by splicing strings
// into it. An earlier version of this script built the field block by hand and
// emitted trailing commas, which produced invalid JSON and — because the
// idempotency check compared against that same hand-built string — wrote the
// block twice on a second run. Serializing from the parsed object makes both
// failures impossible: the output is valid by construction, and the
// "already applied" test is an equality check on parsed data.
//
// Usage: node dev/apply-metadata.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(packageRoot, 'package.json');
const checkOnly = process.argv.includes('--check');

/** The repository this package is published from. */
const REPOSITORY = 'https://github.com/TokamakYuri/dsh-memory-bank';

/** The publication fields this package must declare. */
const METADATA = Object.freeze({
  repository: { type: 'git', url: `git+${REPOSITORY}.git` },
  homepage: `${REPOSITORY}#readme`,
  bugs: { url: `${REPOSITORY}/issues` },
});

/**
 * Field order for the rewritten manifest. Any key not listed keeps its relative
 * position at the end, so an unrelated field added later is never dropped.
 */
const FIELD_ORDER = [
  'name', 'version', 'description', 'type', 'main', 'exports', 'files',
  'keywords', 'license', 'author', 'repository', 'homepage', 'bugs',
  'engines', 'meta', 'dsh',
];

const source = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(source);

const drift = Object.entries(METADATA)
  .filter(([key, value]) => JSON.stringify(manifest[key]) !== JSON.stringify(value))
  .map(([key]) => key);

if (checkOnly) {
  if (drift.length === 0) {
    console.log('publication metadata is present and correct');
    process.exit(0);
  }
  console.log(`package.json needs: ${drift.join(', ')}`);
  process.exit(1);
}

if (drift.length === 0) {
  console.log('publication metadata is present and correct; nothing to do');
  process.exit(0);
}

const merged = { ...manifest, ...METADATA };
const ordered = {};
for (const key of FIELD_ORDER) if (key in merged) ordered[key] = merged[key];
for (const key of Object.keys(merged)) if (!(key in ordered)) ordered[key] = merged[key];

const next = `${JSON.stringify(ordered, null, 2)}\n`;
fs.writeFileSync(manifestPath, next);

// Re-read from disk rather than trusting the in-memory object, and parse it so a
// malformed write fails here instead of in the loader.
const verified = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const [key, value] of Object.entries(METADATA)) {
  if (JSON.stringify(verified[key]) !== JSON.stringify(value)) {
    throw new Error(`package.json: ${key} did not verify after writing`);
  }
}
const lost = Object.keys(manifest).filter((key) => !(key in verified));
if (lost.length > 0) {
  throw new Error(`package.json: rewrite dropped keys: ${lost.join(', ')}`);
}

console.log(`set ${drift.join(', ')} in package.json`);
console.log(`verified: repository=${verified.repository.url}`);
console.log(`verified: ${Object.keys(verified).length} keys present, ${lost.length} lost`);
