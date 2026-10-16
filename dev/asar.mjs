// Read files out of the packaged DSH runtime inside app.asar.
//
// app.asar is a JSON header followed by concatenated file data, so it is
// readable with plain Node — no Electron needed. `apps/web` and the profile
// resolve from inside it, which is why source-level questions about installed
// `@deepseek-ai/*` packages are answered here rather than from a source checkout.
//
// Usage:
//   node dev/asar.mjs list <asarPathPrefix>
//   node dev/asar.mjs cat  <asarFilePath>
//
// `cat` also accepts a regular file path, so the same command reads both worlds.
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'C:/Users/tokam/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

/** Open the archive and return its file index plus the data offset. */
function open() {
  const fd = fs.openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLength = head.readUInt32LE(12);
  const headerBuffer = Buffer.alloc(jsonLength);
  fs.readSync(fd, headerBuffer, 0, jsonLength, 16);
  const header = JSON.parse(headerBuffer.toString('utf8'));
  const entries = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node.files ?? {})) {
      const next = `${prefix}/${key}`;
      if (value.files) walk(value, next);
      else entries.push({ path: next, ...value });
    }
  };
  walk(header, '');
  return { fd, entries, dataOffset: 16 + jsonLength };
}

/** Read one archive entry as text, or `undefined` when it is absent. */
export function readAsar(entryPath) {
  const { fd, entries, dataOffset } = open();
  try {
    const entry = entries.find((candidate) => candidate.path === entryPath);
    if (entry === undefined) return undefined;
    if (!Number.isFinite(Number(entry.offset))) return undefined;
    const buffer = Buffer.alloc(Number(entry.size));
    fs.readSync(fd, buffer, 0, buffer.length, dataOffset + Number(entry.offset));
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const [command, target] = process.argv.slice(2);
if (command === 'list') {
  const { entries } = open();
  for (const entry of entries) if (entry.path.startsWith(target ?? '')) console.log(entry.path);
} else if (command === 'cat') {
  if (fs.existsSync(target)) process.stdout.write(fs.readFileSync(target, 'utf8'));
  else {
    const text = readAsar(target);
    if (text === undefined) {
      console.error(`not found: ${target}`);
      process.exit(1);
    }
    process.stdout.write(text);
  }
} else {
  console.error(`usage: node dev/asar.mjs list <prefix> | cat <path>`);
  void path;
  process.exit(2);
}
