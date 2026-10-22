// Run the plugin against a REAL filesystem, using a copy of another workspace's
// bank. The in-memory harness cannot expose drive-, path- or casing-dependent
// behaviour, and the reported symptom ("missing files") happens in other
// workspaces while this one is fine — so the difference has to be environmental.
//
// The adapter below implements the composed `fs` contract with ordinary Node fs:
// resolve() canonicalizes through realpath like the local provider does, stat()
// reports a version derived from size and mtime, and writeText() honours the same
// createIfAbsent / replaceIfVersion intents under the same sandbox check.
//
// Usage: node dev/real-fs-smoke.mjs [source-bank-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, Config } from '../index.js';

const SOURCE = process.argv[2] ?? 'E:/Work/DSH/.memory-bank';

/** A version token derived from the metadata a real provider would expose. */
function versionOf(absolute) {
  const stat = fs.statSync(absolute);
  return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
}

/** Build a `ctx.fs`-shaped adapter over the real filesystem. */
function realFs() {
  const resolvePath = (p, options = {}) => {
    const base = options.cwd ?? process.cwd();
    const absolute = path.isAbsolute(p) ? p : path.resolve(base, p);
    let canonical = absolute;
    try {
      canonical = fs.realpathSync.native(absolute);
    } catch {
      // Absent paths cannot be canonicalized; the parent can.
      try {
        canonical = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
      } catch {
        canonical = absolute;
      }
    }
    return { targetKey: path.normalize(canonical), displayPath: canonical };
  };

  return {
    async resolve(p, options) {
      return resolvePath(p, options);
    },
    async stat(target) {
      try {
        const stat = fs.statSync(target.displayPath);
        const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
        return { version: versionOf(target.displayPath), type, size: stat.size };
      } catch {
        return undefined;
      }
    },
    async readText(target, signal) {
      if (signal?.aborted) throw new Error('ABORTED');
      return fs.readFileSync(target.displayPath, 'utf8');
    },
    async listDir(target) {
      return fs.readdirSync(target.displayPath).map((name) => ({
        name,
        type: fs.statSync(path.join(target.displayPath, name)).isDirectory() ? 'directory' : 'file',
        target: resolvePath(path.join(target.displayPath, name)),
      }));
    },
    async writeText(target, content, expected, signal, sandboxPolicy) {
      if (signal?.aborted) throw new Error('ABORTED');
      const absolute = target.displayPath;
      if (sandboxPolicy !== undefined) {
        const root = path.resolve(sandboxPolicy.workspaceRoot);
        const relative = path.relative(root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`FS_SANDBOX_DENIED: ${absolute} escapes ${root}`);
        }
        assert.equal(sandboxPolicy.mode, 'workspace-write');
      }
      const existed = fs.existsSync(absolute);
      const before = existed ? fs.readFileSync(absolute, 'utf8') : null;
      if (expected?.kind === 'createIfAbsent' && existed) throw new Error('FS_EXISTS');
      if (expected?.kind === 'replaceIfVersion' && existed && expected.version !== versionOf(absolute)) {
        throw new Error('FS_STALE_VERSION');
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return {
        operation: existed ? 'update' : 'create',
        version: versionOf(absolute),
        before,
        after: content,
      };
    },
  };
}

/** Minimal plugin context around a real-fs adapter. */
function makeHarness(workspace) {
  const tools = new Map();
  const sections = [];
  const warnings = [];
  const fsApi = realFs();
  const toolRegistry = {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  };
  const systemPrompt = { section: (entry) => { sections.push(entry); return () => {}; } };
  const listeners = [];
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    fs: fsApi,
    tools: toolRegistry,
    systemPrompt,
    get: (service) => ({ fs: fsApi, tools: toolRegistry, systemPrompt })[service],
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: (event, handler) => {
      listeners.push({ event, handler });
      return () => {};
    },
  };
  const config = Config['~standard'].validate({});
  assert.equal(config.issues, undefined);
  apply(ctx, config.value);
  /** Dispatch one `agent/pre-step` chain, which is what fills the prompt cache. */
  const preStep = async (agent) => {
    for (const listener of listeners.filter((entry) => entry.event === 'agent/pre-step')) {
      let called = false;
      await listener.handler({ agent, signal: undefined }, async () => {
        called = true;
        return { kind: 'enter', messages: [] };
      });
      assert.ok(called, 'agent/pre-step listener did not call next()');
    }
  };
  return {
    preStep,
    tools, sections, warnings, fsApi,
    agent: (id = 'real-session') => ({ id, session: { header: { cwd: workspace } }, ctx: {} }),
    exec: (agent) => ({ agent, name: 'memory_bank', arguments: {} }),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-real-fs-'));
try {
  // A workspace directory whose bank is a copy of another project's, so the test
  // runs on real Windows paths without touching the original.
  const workspace = path.join(root, 'workspace');
  const bank = path.join(workspace, '.memory-bank');
  fs.mkdirSync(bank, { recursive: true });
  const copied = fs.existsSync(SOURCE) ? fs.readdirSync(SOURCE).filter((n) => n.endsWith('.md')) : [];
  for (const name of copied) fs.copyFileSync(path.join(SOURCE, name), path.join(bank, name));
  console.log(`workspace: ${workspace}`);
  console.log(`copied ${copied.length} file(s) from ${SOURCE}\n`);

  const h = makeHarness(workspace);
  const agent = h.agent();
  const exec = h.exec(agent);
  const call = (args) => h.tools.get('memory_bank').execute(args, exec);

  console.log('1. status lists every file that exists on disk');
  {
    const status = await call({ action: 'status' });
    assert.equal(status.initialized, true);
    assert.equal(status.files.length, copied.length, `expected ${copied.length}, got ${status.files.length}`);
    const onDisk = fs.readdirSync(bank).filter((n) => n.endsWith('.md')).sort();
    const reported = status.files.map((f) => f.name).sort();
    assert.deepEqual(reported, onDisk, 'the tool reports exactly what the directory holds');
  }

  console.log('2. read succeeds for every catalogue file present on disk');
  for (const name of copied) {
    const reading = await call({ action: 'read', file: name });
    assert.equal(reading.file, name);
    assert.ok(reading.text.length > 0, `${name} returned no text`);
  }

  console.log('3. a file that exists is never reported as missing');
  {
    // The exact message the user sees when resolution fails.
    for (const name of copied) {
      try {
        await call({ action: 'read', file: name });
      } catch (error) {
        assert.fail(`"${name}" exists on disk but read failed: ${error.message}`);
      }
    }
  }

  console.log('4. init is a no-op over an existing bank (nothing is "recreated")');
  {
    const before = Object.fromEntries(copied.map((n) => [n, fs.readFileSync(path.join(bank, n), 'utf8')]));
    const report = await call({ action: 'init' });
    assert.deepEqual(report.changed, [], 'created nothing');
    assert.equal(report.kept.length, copied.length, 'kept every existing file');
    for (const name of copied) {
      assert.equal(fs.readFileSync(path.join(bank, name), 'utf8'), before[name], `${name} was modified`);
    }
  }

  console.log('5. write/append round-trip on the real filesystem');
  {
    const written = await call({ action: 'write', file: 'gotchas.md', content: '# Gotchas\n\nreal-fs probe\n' });
    assert.equal(written.ok, true);
    assert.match(fs.readFileSync(path.join(bank, 'gotchas.md'), 'utf8'), /real-fs probe/);
    const appended = await call({ action: 'append', file: 'decisions.md', content: '### D-REAL - probe\n' });
    assert.ok(appended.bytes > 0);
  }

  console.log('6. the prompt section renders the copied bank, verbatim');
  {
    // The cache is filled on the async pre-step path, never on the prompt path.
    await h.preStep(agent);
    const text = h.sections[0].text({ agent });
    assert.match(text, /## Memory Bank \(persistent project memory\)/);
    assert.equal(h.sections[0].interpolate, false);
    // Only the six "inject" files are guaranteed a body; a gisted file whose
    // one-line summary is empty is omitted from the digest by design.
    const injected = ['projectbrief.md', 'productcontext.md', 'techcontext.md',
      'systempatterns.md', 'activecontext.md', 'progress.md'];
    for (const name of injected) {
      assert.match(text, new RegExp(`### ${name.replace('.', '\\.')}`), `${name} missing from the digest`);
    }
    assert.match(text, /Bank files: /);
  }

  console.log('7. a workspace whose bank directory is absent is reported uninitialized, not broken');
  {
    const emptyWorkspace = path.join(root, 'empty');
    fs.mkdirSync(emptyWorkspace, { recursive: true });
    const h2 = makeHarness(emptyWorkspace);
    const status = await h2.tools.get('memory_bank').execute({ action: 'status' }, h2.exec(h2.agent('s2')));
    assert.equal(status.initialized, false);
    assert.deepEqual(status.files, []);
    assert.deepEqual(h2.warnings, [], 'no warning for a merely absent bank');
  }

  console.log('\nAll real-filesystem checks passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
