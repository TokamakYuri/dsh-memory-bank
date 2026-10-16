// Validate the profile patch YAML using the harness's own bundled js-yaml,
// extracted from app.asar into a temp tree so `require` can resolve it.
// Usage: node dev/validate-profile-yaml.cjs <path/to/cordis.patch.yml>
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASAR = 'C:/Users/tokam/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

/** Read the whole asar entry index once. */
function index() {
  const fd = fs.openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const hb = Buffer.alloc(jsonLen);
  fs.readSync(fd, hb, 0, jsonLen, 16);
  const header = JSON.parse(hb.toString('utf8'));
  const entries = [];
  (function walk(node, prefix) {
    for (const [key, value] of Object.entries(node.files || {})) {
      const next = `${prefix}/${key}`;
      if (value.files) walk(value, next);
      else entries.push([next, value]);
    }
  })(header, '');
  return { fd, entries, base: 16 + jsonLen };
}

/** Copy one asar directory subtree to disk. */
function extract(prefix, dest) {
  const { fd, entries, base } = index();
  const normalized = prefix.replace(/\/+$/, '');
  let count = 0;
  for (const [entryPath, meta] of entries) {
    if (!entryPath.startsWith(`${normalized}/`)) continue;
    const relative = entryPath.slice(normalized.length + 1);
    const out = path.join(dest, relative);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const buf = Buffer.alloc(Number(meta.size));
    fs.readSync(fd, buf, 0, buf.length, base + Number(meta.offset));
    fs.writeFileSync(out, buf);
    count += 1;
  }
  fs.closeSync(fd);
  return count;
}

const target = process.argv[2];
if (!target) {
  console.error('usage: node dev/validate-profile-yaml.cjs <cordis.patch.yml>');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-yaml-'));
let doc;
try {
  const copied = extract('/node_modules/js-yaml', path.join(dir, 'js-yaml'));
  if (copied === 0) throw new Error('js-yaml not found in app.asar');
  const yaml = require(path.join(dir, 'js-yaml', 'index.js'));
  doc = yaml.load(fs.readFileSync(target, 'utf8'));
  if (typeof doc === 'string' || typeof doc === 'number' || doc === null) {
    // `load` returns anything the document says; the loader requires an array.
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (!Array.isArray(doc)) throw new Error(`expected a top-level array, got ${doc === null ? 'null' : typeof doc}`);
console.log(`YAML parses: ${doc.length} rows`);

const ids = doc.map((entry) => entry && entry.id).filter(Boolean);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
console.log(`duplicate ids: ${duplicates.length > 0 ? duplicates.join(', ') : '(none)'}`);

const row = doc.find((entry) => entry && entry.id === 'memory-bank');
if (row === undefined) throw new Error('the memory-bank row is missing');
console.log(`memory-bank -> ${row.name}`);
console.log(`config keys: ${Object.keys(row.config).join(', ')}`);
console.log(`inject (${row.config.inject.length}): ${row.config.inject.join(', ')}`);
console.log(`gist (${row.config.gist.length}): ${row.config.gist.join(', ')}`);

// Cross-check: every injected name must exist in the plugin's own catalogue.
(async () => {
  const tools = await import('../src/templates.js');
  const known = new Set(tools.FILE_NAMES);
  for (const name of [...row.config.inject, ...row.config.gist]) {
    if (!known.has(name)) throw new Error(`config names an unknown bank file: ${name}`);
  }
  const overlap = row.config.inject.filter((name) => row.config.gist.includes(name));
  if (overlap.length > 0) throw new Error(`a file cannot be both injected and gisted: ${overlap.join(', ')}`);
  console.log('cross-check: every configured file exists and inject/gist do not overlap');
})();
