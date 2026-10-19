// Prove the prompt-injection boundary the Memory Bank depends on, using the
// harness's own renderers rather than a reimplementation.
//
// The bug this guards against: `renderContextSections` interpolates EVERY
// runtime context with no opt-out, so a bank that documents something as
// ordinary as an Obsidian `{{title}}` placeholder makes prompt assembly throw
// `unknown prompt variable "{{title}}"` and breaks the turn. Only sections
// accept `interpolate: false`, so the contribution MUST be a section.
//
// Everything here imports `@deepseek-ai/dsh-system-prompt` as extracted from the
// packaged `app.asar`, so the assertions are about the shipped behaviour.
//
// Usage: node dev/check-prompt-safety.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ASAR = 'C:/Users/tokam/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

/** Read the asar entry index. */
function readIndex() {
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

/** Extract one asar subtree to disk. */
function extract(prefix, dest) {
  const { fd, entries, dataOffset } = readIndex();
  const normalized = prefix.replace(/\/+$/, '');
  let count = 0;
  try {
    for (const entry of entries) {
      if (!entry.path.startsWith(`${normalized}/`)) continue;
      if (!Number.isFinite(Number(entry.offset))) continue;
      const out = path.join(dest, entry.path.slice(normalized.length + 1));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const buffer = Buffer.alloc(Number(entry.size));
      fs.readSync(fd, buffer, 0, buffer.length, dataOffset + Number(entry.offset));
      fs.writeFileSync(out, buffer);
      count += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

/** The bank-shaped text that used to break a session, taken from a real project. */
const HOSTILE = [
  '## Memory Bank (persistent project memory)',
  '',
  '### techcontext.md',
  '# Tech Context',
  '',
  '| 文档模板 | Obsidian core Templates 兼容 | - | `{{title}}`、`{{date}}` 占位符 |',
  '',
  '### activecontext.md',
  '- 模板中的 `{{title}}` 兼容 Obsidian 核心 Templates。',
].join('\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prompt-'));
try {
  const scope = path.join(dir, 'node_modules', '@deepseek-ai');
  const copied = extract('/dsh/node_modules/@deepseek-ai', scope);
  if (copied === 0) throw new Error('@deepseek-ai not found in app.asar');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'prompt-check', private: true, type: 'module' }));

  const entry = path.join(scope, 'dsh-system-prompt', 'lib', 'index.js');
  const { renderPrompt, renderContextSections } = await import(`file://${entry.replace(/\\/g, '/')}`);

  // The harness registers these two variables in an ordinary session, plus
  // `cwd` from the persona patch; nothing named `title` is ever registered.
  const variables = { provider: 'deepseek', model: 'deepseek-flash', cwd: 'C:/work/project' };

  /** Wrap text as an assembled section. */
  const asSection = (text, interpolate) => ({
    name: 'memory-bank:project-memory',
    text,
    ...(interpolate === undefined ? {} : { interpolate }),
  });

  console.log('1. the contributing form: a section with interpolate:false');
  {
    const prompt = renderPrompt({ sections: [asSection(HOSTILE, false)], contexts: [], tools: [], variables });
    assert.ok(prompt.includes('{{title}}'), '{{title}} survives verbatim');
    assert.ok(prompt.includes('{{date}}'), '{{date}} survives verbatim');
    assert.equal(prompt, HOSTILE, 'the text is passed through unchanged');
  }

  console.log('2. the regression: the same text as a runtime context throws');
  {
    assert.throws(
      () => renderContextSections({ sections: [], contexts: [{ name: 'memory-bank:context', text: HOSTILE }], tools: [], variables }),
      /unknown prompt variable "\{\{title\}\}" in context "memory-bank:context"; registered variables: provider, model, cwd/,
      'this is the exact failure the section form avoids',
    );
  }

  console.log('3. a section without interpolate:false throws too (the flag is load-bearing)');
  {
    assert.throws(
      () => renderPrompt({ sections: [asSection(HOSTILE)], contexts: [], tools: [], variables }),
      /unknown prompt variable "\{\{title\}\}"/,
    );
  }

  console.log('4. a known variable in a section still interpolates by default');
  {
    const prompt = renderPrompt({
      sections: [asSection('model is {{model}}', undefined)],
      contexts: [], tools: [], variables,
    });
    assert.equal(prompt, 'model is deepseek-flash');
  }

  console.log('5. an empty section is dropped, so an uninitialized bank costs nothing');
  {
    assert.equal(renderPrompt({ sections: [asSection('', false)], contexts: [], tools: [], variables }), '');
  }

  console.log('\nAll prompt-safety checks passed against the shipped harness renderers.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
