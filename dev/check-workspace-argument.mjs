// Reproduce the "missing files" symptom as an agent would trigger it.
//
// The `memory_bank` tool accepts an optional `workspace` argument documented as
// "Absolute workspace directory". An agent that wants to point at "the memory
// bank" has three natural guesses, and none of them is the workspace root:
//
//   E:\Work\DSH\.memory-bank      the bank directory itself
//   .memory-bank                  a relative bank path
//   .                             "here"
//
// Every one of those makes the store resolve <guess>/.memory-bank/*.md, so every
// read misses and the tool answers "does not exist yet" for files that plainly
// exist. This script proves the failure before the fix and guards it after.
//
// Usage: node dev/check-workspace-argument.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, Config } from '../index.js';

/** A `ctx.fs`-shaped adapter over the real filesystem (subset the plugin uses). */
function realFs() {
  const resolvePath = (p, options = {}) => {
    const absolute = path.isAbsolute(p) ? p : path.resolve(options.cwd ?? process.cwd(), p);
    let canonical = absolute;
    try {
      canonical = fs.realpathSync.native(absolute);
    } catch {
      canonical = absolute;
    }
    return { targetKey: path.normalize(canonical), displayPath: canonical };
  };
  const versionOf = (absolute) => {
    const stat = fs.statSync(absolute);
    return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
  };
  return {
    async resolve(p, options) { return resolvePath(p, options); },
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
        const relative = path.relative(path.resolve(sandboxPolicy.workspaceRoot), absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`FS_SANDBOX_DENIED: ${absolute}`);
      }
      const existed = fs.existsSync(absolute);
      if (expected?.kind === 'createIfAbsent' && existed) throw new Error('FS_EXISTS');
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return { operation: existed ? 'update' : 'create', version: versionOf(absolute), before: null, after: content };
    },
  };
}

/** Minimal plugin context around a real-fs adapter. */
function makeHarness(workspace) {
  const tools = new Map();
  const fsApi = realFs();
  const toolRegistry = {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  };
  const systemPrompt = { section: () => () => {} };
  const ctx = {
    logger: { warn: () => {} },
    fs: fsApi,
    tools: toolRegistry,
    systemPrompt,
    get: (service) => ({ fs: fsApi, tools: toolRegistry, systemPrompt })[service],
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: () => () => {},
  };
  const config = Config['**'] === undefined ? Config['~standard'].validate({}) : undefined;
  apply(ctx, config.value);
  const agent = { id: 'ws-arg-session', session: { header: { cwd: workspace } }, ctx: {} };
  return {
    tools,
    call: (args) => tools.get('memory_bank').execute(args, { agent, name: 'memory_bank', arguments: {} }),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-arg-'));
try {
  const workspace = path.join(root, 'project');
  const bank = path.join(workspace, '.memory-bank');
  fs.mkdirSync(bank, { recursive: true });
  for (const name of ['projectbrief.md', 'progress.md', 'techcontext.md']) {
    fs.writeFileSync(path.join(bank, name), `# ${name}\n\ncontent for ${name}\n`);
  }

  const h = makeHarness(workspace);
  console.log(`session workspace: ${workspace}\n`);

  console.log('1. baseline: no `workspace` argument');
  {
    const status = await h.call({ action: 'status' });
    assert.equal(status.initialized, true);
    assert.equal(status.files.length, 3);
    assert.equal(status.workspace, workspace, 'the resolved workspace is echoed back');
    console.log(`   -> workspace=${status.workspace}, files=${status.files.length}`);
  }

  console.log('2. `workspace` = the bank directory itself (the natural guess)');
  {
    const status = await h.call({ action: 'status', workspace: bank });
    console.log(`   -> workspace=${status.workspace}, files=${status.files.length}`);
    assert.equal(status.workspace, workspace, 'the bank directory is understood to mean its parent');
    assert.equal(status.files.length, 3);
  }

  console.log('3. a trailing separator on the bank path behaves the same');
  {
    const status = await h.call({ action: 'status', workspace: `${bank}${path.sep}` });
    assert.equal(status.files.length, 3);
  }

  console.log('4. `workspace` = a relative path is refused, naming the session workspace');
  {
    for (const bogus of ['.memory-bank', '.', 'project']) {
      await assert.rejects(
        () => h.call({ action: 'status', workspace: bogus }),
        (error) => {
          assert.match(error.message, /must be an absolute path/);
          assert.ok(error.message.includes(workspace), 'the message names the session workspace to use instead');
          return true;
        },
        `"${bogus}" should be refused`,
      );
    }
    console.log('   -> ".memory-bank", "." and "project" all refused with an actionable message');
  }

  console.log('5. a genuinely different, empty directory still reports empty — and says where it looked');
  {
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    const status = await h.call({ action: 'status', workspace: other });
    assert.equal(status.files.length, 0);
    assert.equal(status.initialized, false);
    const definition = h.tools.get('memory_bank');
    const rendered = definition.output.render({ action: 'status' }, status)[0].text;
    assert.match(rendered, /Looked in/, 'the render names the path it searched');
    assert.match(rendered, /omit `workspace`/, 'and points at the likely mistake');
    console.log(`   -> workspace=${status.workspace}, files=0, with a hint naming the path`);
  }

  console.log('6. `read` on a real file never claims it is missing, whichever spelling is used');
  {
    for (const candidate of [undefined, workspace, bank]) {
      const reading = await h.call({ action: 'read', file: 'progress.md', ...(candidate === undefined ? {} : { workspace: candidate }) });
      assert.match(reading.text, /content for progress\.md/);
    }
    console.log('   -> omitted, project path and bank path all read the same file');
  }

  console.log('7. a missing file names the resolved path, so a wrong guess is visible');
  {
    // `gotchas.md` was never created in this fixture.
    await assert.rejects(
      () => h.call({ action: 'read', file: 'gotchas.md' }),
      (error) => {
        assert.match(error.message, /does not exist in /);
        assert.ok(error.message.includes(path.join(workspace, '.memory-bank')), 'the message names the directory it looked in');
        return true;
      },
    );
    console.log('   -> the error names the resolved bank directory');
  }

  console.log('\nAll workspace-argument checks passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
