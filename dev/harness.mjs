/**
 * Development harness for dsh-memory-bank.
 *
 * Runs the real plugin against an in-memory stand-in for the composed `fs`
 * service and a minimal fake of the Cordis context, so the write path, the
 * `.gitignore` handling, the tool actions and the prompt rendering can all be
 * exercised without a live Harness profile. Not part of the published package.
 *
 * Usage: node dev/harness.mjs
 */

import assert from 'node:assert/strict';
import { join, resolve as pathResolve } from 'node:path';

import { apply, Config } from '../index.js';

const WORKSPACE = 'C:/projects/demo';
const SECOND = 'C:/projects/other';

/** Normalize a path into the fake filesystem's key space. */
function normalize(path) {
  return pathResolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
}

function makeTarget(path) {
  const absolute = normalize(path);
  return { targetKey: `key:${absolute}`, displayPath: absolute };
}

function pathOf(target) {
  return normalize(target.displayPath);
}

/**
 * Build one isolated harness: a fresh in-memory filesystem, a fake Cordis
 * context, and the plugin applied to it.
 * @param {object} [rawConfig] - raw config passed through `Config` validation.
 * @returns {object} the harness handle.
 */
function makeHarness(rawConfig = {}) {
  const files = new Map();

  const fsApi = {
    async resolve(path, options = {}) {
      const base = options.cwd ?? process.cwd();
      const absolute = /^[A-Za-z]:/.test(path) || path.startsWith('/') ? path : join(base, path);
      return makeTarget(absolute);
    },
    async stat(target) {
      const path = pathOf(target);
      if (files.has(path)) {
        const text = files.get(path);
        return { version: `v${text.length}`, type: 'file', size: text.length };
      }
      const prefix = `${path}/`;
      for (const key of files.keys()) if (key.startsWith(prefix)) return { version: 'dir', type: 'directory' };
      return undefined;
    },
    async readText(target) {
      const path = pathOf(target);
      if (!files.has(path)) throw new Error(`FS_NOT_FOUND: ${path}`);
      return files.get(path);
    },
    async writeText(target, content, expected, signal, sandboxPolicy) {
      const path = pathOf(target);
      if (sandboxPolicy !== undefined) {
        const root = normalize(sandboxPolicy.workspaceRoot);
        assert.ok(
          path === root || path.startsWith(`${root}/`),
          `sandbox violation: ${path} escapes ${root}`,
        );
        assert.equal(sandboxPolicy.mode, 'workspace-write');
      }
      const before = files.has(path) ? files.get(path) : null;
      if (expected?.kind === 'createIfAbsent' && before !== null) throw new Error('FS_EXISTS');
      if (expected?.kind === 'replaceIfVersion' && before !== null && expected.version !== `v${before.length}`) {
        throw new Error('FS_STALE_VERSION');
      }
      files.set(path, content);
      return {
        operation: before === null ? 'create' : 'update',
        version: `v${content.length}`,
        before,
        after: content,
      };
    },
  };

  const tools = new Map();
  const toolRegistry = {
    register(definition) {
      assert.equal(typeof definition.name, 'string');
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.output?.render, 'function');
      assert.equal(typeof definition.output?.schema, 'object');
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  };

  const listeners = [];
  const injected = [];
  const warnings = [];
  const systemPrompt = {
    context(entry) {
      injected.push(entry);
      return () => {};
    },
  };

  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    // Cordis exposes declared `inject` services as properties on the plugin
    // context, which is how the plugin reaches `ctx.tools` / `ctx.systemPrompt`.
    fs: fsApi,
    tools: toolRegistry,
    systemPrompt,
    get(service) {
      if (service === 'fs') return fsApi;
      if (service === 'tools') return toolRegistry;
      if (service === 'systemPrompt') return systemPrompt;
      return undefined;
    },
    effect(callback) {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on(event, handler) {
      listeners.push({ event, handler });
      return () => {};
    },
  };

  const config = Config['~standard'].validate(rawConfig);
  assert.equal(config.issues, undefined, `config rejected: ${JSON.stringify(config.issues)}`);
  apply(ctx, config.value);

  return {
    files,
    tools,
    injected,
    warnings,
    config: config.value,
    agent: (cwd, id) => ({ id, session: { header: { cwd } }, ctx: {} }),
    exec: (agent, signal) => ({ agent, signal, name: 'memory_bank', arguments: {} }),
    /** Dispatch one `agent/pre-step` chain, asserting the listener calls `next()`. */
    async preStep(agent) {
      for (const listener of listeners.filter((entry) => entry.event === 'agent/pre-step')) {
        let called = false;
        await listener.handler({ agent, signal: undefined }, async () => {
          called = true;
          return { kind: 'enter', messages: [] };
        });
        assert.ok(called, 'agent/pre-step listener did not call next()');
      }
    },
  };
}

/** Read one seeded bank file from a harness's fake filesystem. */
function bankFile(harness, workspace, name) {
  return harness.files.get(`${normalize(workspace)}/.memory-bank/${name}`);
}

// --- Checks ------------------------------------------------------------------

const h = makeHarness({ inject: ['projectbrief.md', 'activecontext.md'] });
const memoryBank = h.tools.get('memory_bank');
const memoryPlan = h.tools.get('memory_plan');
const agent = h.agent(WORKSPACE, 'session-1');
const exec = h.exec(agent);
const call = (args) => memoryBank.execute(args, exec);

console.log('1. uninitialized workspace reports itself as uninitialized');
{
  const status = await call({ action: 'status' });
  assert.equal(status.initialized, false);
  assert.deepEqual(status.files, []);
  assert.equal(status.folder, '.memory-bank');
  assert.equal(status.root.replace(/\\/g, '/'), `${normalize(WORKSPACE)}/.memory-bank`);
}

console.log('2. the first step seeds the bank without being asked');
{
  await h.preStep(agent);
  for (const name of ['projectbrief.md', 'activecontext.md', 'techcontext.md', 'decisions.md', 'glossary.md', 'gotchas.md', 'index.md', 'progress.md', 'productcontext.md', 'systempatterns.md']) {
    assert.ok(bankFile(h, WORKSPACE, name) !== undefined, `${name} was seeded`);
  }
  const status = await call({ action: 'status' });
  assert.equal(status.initialized, true);
  assert.equal(status.files.length, 10);
  assert.ok(status.files.every((file) => file.bytes > 0));
  assert.ok(status.files.every((file) => file.purpose.length > 0));
}

console.log('3. .gitignore receives the entry exactly once, and only then');
{
  const gitignore = h.files.get(`${normalize(WORKSPACE)}/.gitignore`);
  assert.match(gitignore, /^# DeepSeek Harness Memory Bank/m);
  assert.match(gitignore, /^\.memory-bank\/$/m);
  const before = gitignore;
  await h.preStep(agent);
  await call({ action: 'init' });
  assert.equal(h.files.get(`${normalize(WORKSPACE)}/.gitignore`), before);
}

console.log('4. an existing .gitignore only gains an appended entry');
{
  const g = makeHarness();
  g.files.set(`${normalize(WORKSPACE)}/.gitignore`, 'node_modules/\ndist/');
  await g.preStep(g.agent(WORKSPACE, 's'));
  const text = g.files.get(`${normalize(WORKSPACE)}/.gitignore`);
  assert.match(text, /^node_modules\/\ndist\/\n\n# DeepSeek Harness Memory Bank/);
  assert.match(text, /\.memory-bank\/$/m);

  const already = makeHarness();
  already.files.set(`${normalize(WORKSPACE)}/.gitignore`, '.memory-bank/\n');
  await already.preStep(already.agent(WORKSPACE, 's'));
  assert.equal(already.files.get(`${normalize(WORKSPACE)}/.gitignore`), '.memory-bank/\n');

  const slashed = makeHarness();
  slashed.files.set(`${normalize(WORKSPACE)}/.gitignore`, '/.memory-bank/\n');
  await slashed.preStep(slashed.agent(WORKSPACE, 's'));
  assert.equal(slashed.files.get(`${normalize(WORKSPACE)}/.gitignore`), '/.memory-bank/\n');

  // A Windows-written .gitignore must not gain a duplicate entry either.
  const crlf = makeHarness();
  crlf.files.set(`${normalize(WORKSPACE)}/.gitignore`, 'node_modules/\r\n.memory-bank/\r\n');
  await crlf.preStep(crlf.agent(WORKSPACE, 's'));
  assert.equal(crlf.files.get(`${normalize(WORKSPACE)}/.gitignore`), 'node_modules/\r\n.memory-bank/\r\n');
}

console.log('5. write and read round-trip a file the agent owns');
{
  const outcome = await call({
    action: 'write',
    file: 'techcontext',
    content: '# Tech Context\n\n**Last updated**: 2026-01-01\n\n## Languages and Runtimes\n\nNode 24, plain ESM, no build step.\n',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.file, 'techcontext.md');
  assert.equal(outcome.created, false, 'an existing template file is updated, not created');
  const read = await call({ action: 'read', file: 'techcontext.md' });
  assert.match(read.text, /Node 24, plain ESM, no build step\./);
  assert.equal(read.truncated, false);
}

console.log('6. append grows the decision log without rewriting it');
{
  const before = await call({ action: 'read', file: 'decisions.md' });
  const outcome = await call({
    action: 'append',
    file: 'decisions.md',
    content: '### D-002 - Fake the fs service in tests\n\n- **Status**: accepted\n- **Decision**: drive the plugin against an in-memory fs.\n',
  });
  assert.ok(outcome.bytes > before.bytes);
  const after = await call({ action: 'read', file: 'decisions.md' });
  assert.match(after.text, /D-002/);
  assert.match(after.text, /D-001/, 'the existing log survived the append');
}

console.log('7. grep searches every bank file at once');
{
  const found = await call({ action: 'grep', query: 'IN-MEMORY FS' });
  assert.ok(found.matches.length >= 1, 'case-insensitive search found the entry');
  assert.equal(found.matches[0].file, 'decisions.md');
  assert.ok(found.matches[0].line > 0);
  assert.match(found.matches[0].text, /in-memory fs/i);
}

console.log('8. bad input is refused with text the model can act on');
{
  await assert.rejects(() => call({ action: 'write', file: 'notes.txt', content: 'x' }), /known bank file/i);
  await assert.rejects(() => call({ action: 'write', file: 'techcontext.md' }), /requires a string `content`/);
  await assert.rejects(() => call({ action: 'write', file: 'progress.md', content: '   ' }), /non-empty `content`/);
  await assert.rejects(() => call({ action: 'grep', query: '   ' }), /non-empty `query`/);
  await assert.rejects(() => call({ action: 'read', file: 'projectbrief.md', workspace: SECOND }), /does not exist yet/);
}

console.log('9. each workspace gets its own bank, confined by the sandbox policy');
{
  const other = h.agent(SECOND, 'session-2');
  await h.preStep(other);
  assert.ok(bankFile(h, SECOND, 'projectbrief.md') !== undefined, 'second workspace seeded');
  assert.notEqual(bankFile(h, SECOND, 'projectbrief.md'), undefined);
  const status = await memoryBank.execute({ action: 'status' }, h.exec(other));
  assert.equal(status.root.replace(/\\/g, '/'), `${normalize(SECOND)}/.memory-bank`);
  const write = await memoryBank.execute(
    { action: 'write', file: 'progress.md', content: '# Progress\n\n**Last updated**: today\n\nsecond workspace\n' },
    h.exec(other),
  );
  assert.equal(write.ok, true);
  assert.notEqual(bankFile(h, SECOND, 'progress.md'), bankFile(h, WORKSPACE, 'progress.md'));
}

console.log('10. the prompt carries the injected files and nothing else');
{
  await h.preStep(agent);
  assert.equal(h.injected.length, 1);
  const entry = h.injected[0];
  assert.equal(entry.name, 'memory-bank:context');
  assert.equal(typeof entry.text, 'function');
  const text = entry.text({ agent, scope: agent });
  assert.match(text, /## Memory Bank \(persistent project memory\)/);
  assert.match(text, /### projectbrief\.md/);
  assert.match(text, /### activecontext\.md/);
  assert.match(text, /Node 24, plain ESM, no build step\./, 'the written techcontext body appears');
  assert.match(text, /Bank files: /);
  assert.match(text, /`decisions\.md`/, 'the file list still names every bank file');
  assert.ok(text.length < 24_000, `respects injectBudget (was ${text.length})`);
}

console.log('11. an untouched workspace gets the bootstrap line, not an empty section');
{
  const cold = makeHarness({ autoInitialize: false, inject: ['projectbrief.md'] });
  const coldAgent = cold.agent('C:/projects/cold', 'session-cold');
  const text = cold.injected[0].text({ agent: coldAgent });
  assert.match(text, /memory_bank/);
  assert.match(text, /status/);
  assert.doesNotMatch(text, /### /, 'no file bodies before the first read');
}

console.log('12. autoInitialize=false never writes to disk');
{
  const off = makeHarness({ autoInitialize: false });
  const untouched = 'C:/projects/untouched';
  await off.preStep(off.agent(untouched, 'session-off'));
  assert.equal(off.files.size, 0, 'no files created');
  const status = await off.tools.get('memory_bank').execute({ action: 'status' }, off.exec(off.agent(untouched, 's')));
  assert.equal(status.initialized, false);
}

console.log('13. memory_plan returns the ritual');
{
  const ritual = await memoryPlan.execute({}, exec);
  assert.match(ritual, /Memory Bank update ritual/);
  assert.match(ritual, /activecontext\.md/);
  assert.match(ritual, /sync/);
  assert.deepEqual(Object.keys(memoryPlan.parameters.properties), []);
}

console.log('14. every action renders a non-empty result');
{
  const samples = [
    { action: 'list', ok: true, folder: '.memory-bank', root: 'r', files: [] },
    { action: 'read', ok: true, folder: '.memory-bank', root: 'r', file: 'progress.md', text: 'body', truncated: false },
    { action: 'read', ok: true, folder: '.memory-bank', root: 'r', file: 'progress.md', text: 'body', truncated: true },
    { action: 'grep', ok: true, folder: '.memory-bank', root: 'r', matches: [{ file: 'progress.md', line: 3, text: 'hit' }] },
    { action: 'grep', ok: true, folder: '.memory-bank', root: 'r', matches: [] },
    { action: 'write', ok: true, folder: '.memory-bank', root: 'r', file: 'progress.md', bytes: 10, created: true },
    { action: 'append', ok: true, folder: '.memory-bank', root: 'r', file: 'decisions.md', bytes: 10, created: false },
    { action: 'init', ok: true, folder: '.memory-bank', root: 'r', changed: ['a.md'], kept: ['b.md'], gitignore: true },
    { action: 'sync', ok: true, folder: '.memory-bank', root: 'r', initialized: true },
    { action: 'status', ok: true, folder: '.memory-bank', root: 'r', initialized: false },
    { action: 'status', ok: true, folder: '.memory-bank', root: 'r', initialized: true, focus: 'Wire it up', files: [{ name: 'projectbrief.md', title: 'Project Brief', purpose: 'p', bytes: 12 }] },
  ];
  for (const value of samples) {
    const blocks = memoryBank.output.render({ action: value.action }, value);
    assert.equal(blocks[0].type, 'text');
    assert.ok(blocks[0].text.trim().length > 0, `${value.action} rendered empty`);
  }
}

console.log('15. config validation rejects bad input and accepts partial overrides');
{
  const bad = Config['~standard'].validate({ injectBudget: 'lots' });
  assert.ok(bad.issues.length > 0);
  assert.ok(bad.issues[0].path.includes('injectBudget'));
  const typo = Config['~standard'].validate({ inject: ['techcontext.md', 'nonexistent.md'] });
  assert.ok(typo.issues.some((issue) => /names no known/.test(issue.message)));
  const empty = Config['~standard'].validate(undefined);
  assert.equal(empty.issues, undefined);
  assert.ok(empty.value.inject.includes('projectbrief.md'));
  assert.ok(empty.value.gist.includes('decisions.md'), 'extras default to gist injection');
  const relaxed = Config['~standard'].validate({ autoInitialize: false, gitignore: false, folder: 'memory/' });
  assert.equal(relaxed.value.folder, 'memory');
  assert.equal(relaxed.value.autoInitialize, false);
  assert.equal(relaxed.value.gitignore, false);
  const notObject = Config['~standard'].validate('nope');
  assert.ok(notObject.issues.length > 0);
}

console.log('16. gitignore=false seeds the bank but leaves .gitignore alone');
{
  const quiet = makeHarness({ gitignore: false });
  await quiet.preStep(quiet.agent(WORKSPACE, 's'));
  assert.ok(bankFile(quiet, WORKSPACE, 'projectbrief.md') !== undefined, 'bank still seeded');
  assert.equal(quiet.files.has(`${normalize(WORKSPACE)}/.gitignore`), false, '.gitignore untouched');
}

console.log('17. a hostile workspace argument cannot escape the sandbox');
{
  const escaped = await call({ action: 'status', workspace: '../outside' });
  assert.ok(normalize(escaped.root).includes('outside'), 'explicit workspace is honored');
  // The fake fs asserts containment on every write, so any escape would throw.
  const written = await call({ action: 'write', file: 'progress.md', content: '# Progress\n\nok\n' });
  assert.equal(written.ok, true);
}

console.log('\nAll harness checks passed.');
