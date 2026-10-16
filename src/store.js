/**
 * Workspace-bound Memory Bank storage.
 *
 * One {@link MemoryBankStore} exists per workspace directory and owns every read
 * and write of `.memory-bank/`. Mutations always go through the composed `fs`
 * service with an explicit workspace-write sandbox policy, so the bank is
 * confined to the workspace root by the same mechanism that confines the
 * agent's own `write` tool.
 *
 * Reads are cached per workspace with a short TTL. The prompt contribution is
 * assembled on a synchronous path that cannot await I/O, so the cache is what
 * makes per-step injection affordable; every tool call and every TTL expiry
 * re-reads from disk, so a hand-edited bank is picked up within seconds.
 *
 * @module dsh-memory-bank/store
 */

import { join, resolve } from 'node:path';
import { FILES, findFile, initialFiles, parseIndexInjections, purposeOf, summarize } from './templates.js';

/** Marker written above the `.gitignore` entry so a human can tell who added it. */
const GITIGNORE_MARKER = '# DeepSeek Harness Memory Bank (added by dsh-memory-bank)';

/** How long a cached read stays authoritative before the next access re-reads disk. */
const CACHE_TTL_MS = 2000;

/** Closing brace of the fragment appended after a truncated file body. */
const TRUNCATION_NOTICE = '\n\n... [truncated by dsh-memory-bank; read the file for the rest]';

/**
 * Normalize a filesystem path into a stable cache key.
 * @param {string} path - absolute workspace directory.
 * @returns {string} case-normalized key.
 */
function cacheKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/**
 * Read `path` and return its text, or `undefined` when it does not exist or is
 * not a regular text file. Every failure is intentionally collapsed: a missing
 * bank is a normal state, not an error.
 * @param {{ readText: Function, stat: Function, resolve: Function }} fsApi - composed fs service.
 * @param {string} path - absolute or cwd-relative path.
 * @param {{ cwd?: string, signal?: AbortSignal }} options - provider resolution options.
 * @returns {Promise<{ text: string, version: unknown, size: number } | undefined>} the reading.
 */
async function tryRead(fsApi, path, options) {
  let target;
  try {
    target = await fsApi.resolve(path, options);
  } catch {
    return undefined;
  }
  let info;
  try {
    info = await fsApi.stat(target, options.signal);
  } catch {
    return undefined;
  }
  if (info === undefined || info.type !== 'file') return undefined;
  try {
    const text = await fsApi.readText(target, options.signal);
    return { text, version: info.version, size: text.length };
  } catch {
    return undefined;
  }
}

/**
 * One workspace's Memory Bank.
 *
 * The store is deliberately passive about lifecycle: it holds no timers and
 * registers nothing. The plugin owns creation, caching and disposal.
 */
export class MemoryBankStore {
  /** @type {string} absolute workspace directory this store is bound to. */
  workspace;

  /** @type {string} bank directory name, relative to the workspace. */
  folder;

  /** @type {string} absolute bank directory path. */
  root;

  /**
   * The composed `fs` service. Public because the registry rebinds it when the
   * plugin reloads and a fresh service instance replaces the old one.
   * @type {object}
   */
  fs;

  /** @type {object} resolved plugin configuration. */
  #config;

  /** @type {{ value: object, at: number } | undefined} last successful read. */
  #cache;

  /** @type {Promise<object> | undefined} in-flight read, so concurrent callers share one pass. */
  #inflight;

  /** @type {string | undefined} prompt text rendered from the cached view. */
  #context;

  /**
   * Whether a first-run seed has already succeeded for this workspace.
   *
   * Lives on the store rather than in the plugin so a plugin reload does not
   * re-seed, and stays `false` after a failed attempt so a transient failure (a
   * workspace that is read-only now and writable later) can still be retried.
   * @type {boolean}
   */
  seedAttempted = false;

  /**
   * @param {object} options - store construction options.
   * @param {string} options.workspace - absolute workspace directory.
   * @param {object} options.config - resolved plugin configuration.
   * @param {object} options.fs - the composed `fs` service.
   */
  constructor({ workspace, config, fs }) {
    this.workspace = resolve(workspace);
    this.folder = config.folder;
    this.root = join(this.workspace, config.folder);
    this.#config = config;
    this.fs = fs;
  }

  /** Drop cached state so the next read hits disk. */
  invalidate() {
    this.#cache = undefined;
    this.#inflight = undefined;
    this.#context = undefined;
  }

  /**
   * The prompt contribution rendered from the last read, for the synchronous
   * assembly path. Returns `undefined` when nothing has been read yet, which is
   * the signal to fall back to the bootstrap line.
   * @returns {string | undefined} cached prompt text.
   */
  cachedContext() {
    return this.#context;
  }

  /** @returns {boolean} whether the last read found an initialized bank. */
  get initialized() {
    return this.#cache?.value?.initialized === true;
  }

  /**
   * Provider resolution options for a session-scoped call.
   * @param {{ sessionId?: string, signal?: AbortSignal, cwd?: string }} scope - call scope.
   * @returns {object} options for `fs.resolve` / `fs.stat` / `fs.readText`.
   */
  #resolveOptions(scope = {}) {
    const cwd = scope.cwd ?? this.workspace;
    return {
      cwd,
      ...(scope.signal === undefined ? {} : { signal: scope.signal }),
    };
  }

  /**
   * The sandbox policy a mutation runs under: workspace-write rooted at this
   * store's workspace. The bank can never escape it, and a write inside the
   * workspace needs no separate approval.
   * @param {{ sessionId?: string }} scope - call scope.
   * @returns {{ mode: string, workspaceRoot: string, sessionId?: string }} the policy.
   */
  #sandbox(scope = {}) {
    return {
      mode: 'workspace-write',
      workspaceRoot: this.workspace,
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    };
  }

  /**
   * Resolve a bank-relative file name to a provider target.
   * @param {string} name - file name inside the bank directory.
   * @param {object} scope - call scope.
   * @returns {Promise<object>} the resolved target.
   */
  async #target(name, scope) {
    return this.fs.resolve(join(this.folder, name), this.#resolveOptions(scope));
  }

  /**
   * Read one bank file.
   * @param {string} name - file name inside the bank directory.
   * @param {object} scope - call scope.
   * @returns {Promise<{ text: string, version: unknown, size: number } | undefined>} the reading.
   */
  async readFile(name, scope = {}) {
    return tryRead(this.fs, join(this.folder, name), this.#resolveOptions(scope));
  }

  /**
   * Read the whole bank and build the prompt-facing digest.
   *
   * The returned object is plain JSON and is what both the prompt contribution
   * and the `status` tool action render from, so the two never disagree.
   *
   * @param {{ force?: boolean }} [options] - `force` bypasses the cache.
   * @returns {Promise<object>} the bank view.
   */
  async load({ force = false } = {}) {
    const fresh = this.#cache !== undefined && Date.now() - this.#cache.at < CACHE_TTL_MS;
    if (!force && fresh) return this.#cache.value;
    if (!force && this.#inflight !== undefined) return this.#inflight;
    const pass = this.#read();
    this.#inflight = pass;
    try {
      const value = await pass;
      this.#cache = { value, at: Date.now() };
      return value;
    } finally {
      if (this.#inflight === pass) this.#inflight = undefined;
    }
  }

  /**
   * Perform one full read of the bank directory.
   * @returns {Promise<object>} the bank view.
   */
  async #read() {
    const scope = {};
    const entries = [];
    /** @type {Map<string, { text: string, version: unknown, size: number }>} */
    const readings = new Map();

    // Every catalogue name is read by name, because the digest and `grep` both
    // need bodies the configuration may not list, and a name-based read costs one
    // stat plus one read regardless of how many files the directory holds.
    const wanted = [...new Set([...this.#config.inject, 'index.md', ...FILES.map((file) => file.name)])];
    for (const name of wanted) {
      const reading = await this.readFile(name, scope);
      if (reading !== undefined) readings.set(name, reading);
    }

    const indexText = readings.get('index.md')?.text ?? '';
    const declared = parseIndexInjections(indexText);
    const injected = declared.full.length > 0 || declared.gist.length > 0
      ? { full: declared.full, gist: declared.gist }
      : {
        full: this.#config.inject,
        gist: this.#config.gist,
      };

    const documents = [];
    for (const [name, reading] of readings) {
      const catalogue = findFile(name);
      entries.push({
        name,
        title: catalogue?.title ?? name,
        purpose: purposeOf(name),
        bytes: reading.size,
      });
      documents.push({ name, text: reading.text });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    const fullDocuments = [];
    for (const name of injected.full) {
      const reading = readings.get(name);
      if (reading === undefined) continue;
      const body = reading.text.trim();
      if (body.length === 0) continue;
      fullDocuments.push({ name, text: body });
    }

    const gists = [];
    for (const name of injected.gist) {
      const reading = readings.get(name);
      if (reading === undefined) continue;
      const text = summarize(reading.text, this.#config.gistChars);
      if (text.length === 0) continue;
      gists.push({ name, text });
    }

    const focusReading = readings.get('activecontext.md');
    const focus = focusReading === undefined ? '' : summarize(focusReading.text, this.#config.gistChars);

    // The foundation document is the marker: seeds always write it, and a bank
    // without it is a directory of loose notes rather than a Memory Bank.
    const initialized = readings.has('projectbrief.md');
    return {
      workspace: this.workspace,
      root: this.root,
      folder: this.folder,
      initialized,
      focus,
      entries,
      documents,
      fullDocuments,
      gists,
      readAt: Date.now(),
    };
  }

  /**
   * Render the system-prompt contribution for this workspace.
   *
   * Budget order: the current focus always survives, then injected files in
   * catalogue order, truncated per file and then overall. An uninitialized
   * workspace yields an empty string so the plugin costs nothing until it is
   * actually in use.
   *
   * @returns {Promise<string>} the prompt text, or an empty string.
   */
  async renderContext() {
    if (this.#config.injectBudget <= 0) {
      this.#context = '';
      return '';
    }
    const view = await this.load();
    if (!view.initialized) {
      this.#context = '';
      return '';
    }

    const sections = [];
    for (const document of view.fullDocuments) {
      const body = document.text.length <= this.#config.fileBudget
        ? document.text
        : document.text.slice(0, this.#config.fileBudget) + TRUNCATION_NOTICE;
      sections.push(`### ${document.name}\n${body}`);
    }
    for (const entry of view.gists) sections.push(`### ${entry.name}\n${entry.text}`);

    const body = sections.join('\n\n');
    if (body.trim().length === 0) {
      this.#context = '';
      return '';
    }

    const header = [
      '## Memory Bank (persistent project memory)',
      '',
      `Durable project memory for this workspace lives in \`${this.folder}/\`. It is maintained across`,
      'conversations on purpose: treat it as already-known context, not as a request. Verify anything',
      'that contradicts the current code before relying on it, and correct the bank when you find it stale.',
      '',
    ].join('\n');

    const budget = this.#config.injectBudget;
    const clipped = body.length <= budget
      ? body
      : `${body.slice(0, budget)}${TRUNCATION_NOTICE}`;

    const fileList = view.entries.map((entry) => `\`${entry.name}\``).join(', ');
    const planHint = this.#config.planHint
      ? ' Call `memory_plan` when a work session ends.'
      : '';
    const footer = [
      '',
      `Bank files: ${fileList || '(none)'}. Read any of them directly for detail, and update them with the \`memory_bank\` tool.${planHint}`,
    ].join('\n');

    this.#context = `${header}${clipped}${footer}`;
    return this.#context;
  }

  /**
   * Create the bank directory, its template files and the `.gitignore` entry.
   *
   * Never overwrites an existing file. Returns a per-file report so the caller
   * can tell "created" from "already present" without a second read. The
   * `.gitignore` step honours the `gitignore` configuration flag, so turning it
   * off seeds the bank without touching the repository's ignore rules.
   *
   * @param {object} scope - call scope carrying the session id and signal.
   * @returns {Promise<object>} the initialization report.
   */
  async initialize(scope) {
    const created = [];
    const kept = [];
    for (const file of initialFiles()) {
      const existing = await this.readFile(file.name, scope);
      if (existing !== undefined) {
        kept.push(file.name);
        continue;
      }
      await this.writeFile(file.name, file.content, scope, { mode: 'create' });
      created.push(file.name);
    }
    const gitignore = this.#config.gitignore
      ? await this.#ensureGitignore(scope)
      : { changed: false, path: '.gitignore', created: false };
    this.seedAttempted = true;
    this.invalidate();
    return {
      root: this.root,
      created,
      kept,
      gitignore,
    };
  }

  /**
   * Write one bank file.
   *
   * @param {string} name - file name inside the bank directory.
   * @param {string} content - the complete new body.
   * @param {object} scope - call scope carrying the session id and signal.
   * @param {{ mode?: 'create' | 'replace' }} [options] - `create` refuses to
   *   overwrite an existing file; `replace` is unconditional.
   * @returns {Promise<{ operation: string, bytes: number, created: boolean }>} the outcome.
   */
  async writeFile(name, content, scope, { mode = 'replace' } = {}) {
    const existing = await this.readFile(name, scope);
    if (mode === 'create' && existing !== undefined) {
      throw new Error(`${this.folder}/${name} already exists`);
    }
    const target = await this.#target(name, scope);
    const expected = mode === 'create'
      ? { kind: 'createIfAbsent' }
      : existing === undefined
        ? undefined
        : { kind: 'replaceIfVersion', version: existing.version };
    const outcome = await this.fs.writeText(
      target,
      content,
      expected,
      scope.signal,
      this.#sandbox(scope),
    );
    this.invalidate();
    return {
      operation: outcome.operation,
      bytes: content.length,
      created: outcome.operation === 'create',
    };
  }

  /**
   * Append a section to a bank file, creating it when absent.
   *
   * This is the append-only path the decision log depends on: callers add
   * entries and never have to re-send the existing body.
   *
   * @param {string} name - file name inside the bank directory.
   * @param {string} content - the section to append.
   * @param {object} scope - call scope.
   * @returns {Promise<{ operation: string, bytes: number, created: boolean }>} the outcome.
   */
  async appendFile(name, content, scope) {
    const existing = await this.readFile(name, scope);
    const separator = existing === undefined || existing.text.endsWith('\n') ? '' : '\n';
    const prefix = existing === undefined ? '' : `${existing.text}${separator}`;
    const next = `${prefix}${prefix.length > 0 ? '\n' : ''}${content.replace(/^\n+/, '')}`;
    if (next.length > this.#config.maxFileChars) {
      throw new Error(
        `appending would grow ${this.folder}/${name} to ${next.length} characters, over maxFileChars=${this.#config.maxFileChars}; summarise the file with memory_bank action "write" instead of appending`,
      );
    }
    return this.writeFile(name, next, scope);
  }

  /**
   * Ensure the workspace `.gitignore` ignores the bank directory.
   *
   * Idempotent: an entry already present in any spelling (`folder`, `folder/`,
   * `/folder/`) is left alone. A missing `.gitignore` is created rather than
   * skipped, because the point of the entry is that the bank never reaches the
   * repository — including the first commit.
   *
   * @param {object} scope - call scope.
   * @returns {Promise<{ changed: boolean, path: string, created: boolean }>} the outcome.
   */
  async #ensureGitignore(scope) {
    // Compare on the folder name alone so every spelling git accepts counts as
    // already present: `foo`, `foo/`, `/foo`, `/foo/`, and a `\r` left by a file
    // written on Windows. The store's `seedAttempted` flag is not sufficient
    // protection against a duplicate append, because a plugin reload builds a
    // fresh store and would run this again.
    const wanted = this.folder.replace(/[/\\]+$/, '');
    const existing = await tryRead(this.fs, '.gitignore', this.#resolveOptions(scope));
    if (existing !== undefined) {
      const present = existing.text.split(/\r?\n/).some((raw) => {
        const line = raw.trim().replace(/^\/+/, '').replace(/[/\\]+$/, '');
        return line === wanted;
      });
      if (present) return { changed: false, path: '.gitignore', created: false };
      const separator = existing.text.length === 0 || existing.text.endsWith('\n') ? '' : '\n';
      const next = `${existing.text}${separator}\n${GITIGNORE_MARKER}\n${this.folder}/\n`;
      const target = await this.fs.resolve('.gitignore', this.#resolveOptions(scope));
      await this.fs.writeText(target, next, undefined, scope.signal, this.#sandbox(scope));
      return { changed: true, path: '.gitignore', created: false };
    }
    const target = await this.fs.resolve('.gitignore', this.#resolveOptions(scope));
    await this.fs.writeText(
      target,
      `${GITIGNORE_MARKER}\n${this.folder}/\n`,
      { kind: 'createIfAbsent' },
      scope.signal,
      this.#sandbox(scope),
    );
    return { changed: true, path: '.gitignore', created: true };
  }
}

/**
 * Per-workspace store registry.
 *
 * Stores are cheap and hold only a cache, so the registry keeps one per
 * workspace directory for the lifetime of the plugin.
 */
export class StoreRegistry {
  /** @type {Map<string, MemoryBankStore>} */
  #stores = new Map();

  /** @type {object} resolved plugin configuration. */
  #config;

  /** @type {() => object | undefined} late-bound accessor for the composed `fs` service. */
  #fsOf;

  /**
   * @param {object} options - registry options.
   * @param {object} options.config - resolved plugin configuration.
   * @param {() => object | undefined} options.fsOf - resolves the live `fs` service.
   */
  constructor({ config, fsOf }) {
    this.#config = config;
    this.#fsOf = fsOf;
  }

  /**
   * Get or create the store for one workspace.
   * @param {string} workspace - absolute workspace directory.
   * @returns {MemoryBankStore | undefined} the store, or `undefined` when no `fs` service is mounted.
   */
  get(workspace) {
    const fs = this.#fsOf();
    if (fs === undefined) return undefined;
    const key = cacheKey(workspace);
    const existing = this.#stores.get(key);
    if (existing !== undefined) {
      existing.fs = fs;
      return existing;
    }
    const store = new MemoryBankStore({ workspace, config: this.#config, fs });
    this.#stores.set(key, store);
    return store;
  }

  /** Drop every cached workspace view. */
  invalidateAll() {
    for (const store of this.#stores.values()) store.invalidate();
  }
}
