// Assert the plugin's tool schemas against the REAL harness validator
// (`@deepseek-ai/dsh-tools/lib/types/json-schema.js`) extracted from app.asar.
//
// The dev/check-schemas.mjs transliteration is a fast guard; this is the
// authority, because a mismatch here is exactly the failure that silently
// unregisters a tool.
//
// Usage: node dev/check-schemas-against-harness.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { memoryBankTool, memoryPlanTool } from '../src/tools.js';

const ASAR = 'C:/Users/tokam/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const PACKAGE_ROOT = '/dsh/node_modules/@deepseek-ai/dsh-tools';

/** Read the asar entry index. */
function index() {
  const fd = fs.openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const hb = Buffer.alloc(jsonLen);
  fs.readSync(fd, hb, 0, jsonLen, 16);
  const header = JSON.parse(hb.toString('utf8'));
  const entries = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node.files || {})) {
      const next = `${prefix}/${key}`;
      if (value.files) walk(value, next);
      else entries.push([next, value]);
    }
  };
  walk(header, '');
  return { fd, entries, base: 16 + jsonLen };
}

/** Extract one asar subtree to disk. */
function extract(prefix, dest) {
  const { fd, entries, base } = index();
  const normalized = prefix.replace(/\/+$/, '');
  let count = 0;
  for (const [entryPath, meta] of entries) {
    if (!entryPath.startsWith(`${normalized}/`)) continue;
    // Unpacked entries carry no offset; they live beside the asar as real files.
    if (!Number.isFinite(Number(meta.offset)) || !Number.isFinite(Number(meta.size))) continue;
    const out = path.join(dest, entryPath.slice(normalized.length + 1));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const buf = Buffer.alloc(Number(meta.size));
    fs.readSync(fd, buf, 0, buf.length, base + Number(meta.offset));
    fs.writeFileSync(out, buf);
    count += 1;
  }
  fs.closeSync(fd);
  return count;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-'));
let assertSupported;
try {
  // `json-schema.js` cross-imports sibling @deepseek-ai packages, so extract the
  // whole scope and resolve through it rather than one package at a time.
  const scope = path.join(dir, 'node_modules', '@deepseek-ai');
  const copied = extract('/dsh/node_modules/@deepseek-ai', scope);
  if (copied === 0) throw new Error('@deepseek-ai not found in app.asar');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'schema-check', private: true, type: 'module' }, null, 2),
  );
  const entry = path.join(scope, 'dsh-tools', 'lib', 'types', 'json-schema.js');
  const mod = await import(`file://${entry.replace(/\\/g, '/')}`);
  assertSupported = mod.assertSupportedJsonSchema;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const [label, schema] of [
  ['memory_bank.parameters', memoryBankTool().parameters],
  ['memory_bank.output.schema', memoryBankTool().output.schema],
  ['memory_plan.parameters', memoryPlanTool().parameters],
  ['memory_plan.output.schema', memoryPlanTool().output.schema],
]) {
  try {
    assertSupported(schema);
    console.log(`OK   ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.exitCode !== 1) console.log('\nAll schemas pass the real harness validator.');
