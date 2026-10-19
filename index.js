/**
 * Memory Bank — persistent workspace memory for DeepSeek Harness.
 *
 * The problem this solves is not "the context window is too small". It is that a
 * *new* conversation in the same workspace starts knowing nothing: not the stack,
 * not the decisions already taken, not the task that was in flight. The harness
 * can compact a long conversation, but compaction cannot help a conversation that
 * never had the information.
 *
 * So the Memory Bank keeps that information where the project lives, in
 * `.memory-bank/`, and reads it back into every session's system prompt. Three
 * mechanisms do the work:
 *
 * 1. `systemPrompt.section(..., interpolate: false)` appends the bank digest to
 *    the system prompt, resolved from the calling agent's `session.header.cwd`.
 *    A different workspace gets a different bank; the same workspace gets the
 *    same bank in every session. `interpolate: false` is mandatory here because
 *    the bank is arbitrary project prose: a runtime *context* is always
 *    `{{variable}}`-interpolated, so ordinary text such as an Obsidian
 *    `{{title}}` placeholder would otherwise throw during assembly.
 * 2. The `memory_bank` tool maintains it, writing through the composed `fs`
 *    service under an explicit workspace-write sandbox policy, so the bank can
 *    never escape the workspace.
 * 3. First use creates `.memory-bank/` with templates and adds the folder to the
 *    workspace `.gitignore`, so the bank never lands in the repository.
 *
 * @module dsh-memory-bank
 */

import { dirname, join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { StoreRegistry } from './src/store.js';
import { ACTIONS, memoryBankTool, memoryPlanRitual, memoryPlanTool } from './src/tools.js';
import { FILES, findFile } from './src/templates.js';

/** Stable Cordis plugin name used by loader diagnostics and the bundle patch id. */
export const name = 'memory-bank';

/**
 * Load trace, opt-in through `DSH_MEMORY_BANK_TRACE`.
 *
 * A tool registration can fail in a way the Loader never reports — the plugin
 * activates and contributes its prompt text while every tool it registered is
 * silently absent. This appends one line per activation and per refusal so that
 * failure is diagnosable instead of invisible.
 *
 * Tracing is OFF unless the environment variable names a log file, because a
 * library has no business writing into its own package directory: on a
 * `node_modules` install that directory is shared and managed by the package
 * manager. Set it to the literal value `stderr` to log to the host's stderr
 * instead of a file.
 *
 * @param {string} message - one line to record.
 */
function trace(message) {
  if (trace.enabled !== true) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    if (trace.toStderr === true) process.stderr.write(line);
    else appendFileSync(trace.path, line);
  } catch {
    /* a failed trace must never break activation */
  }
}

trace.path = process.env.DSH_MEMORY_BANK_TRACE ?? '';
trace.toStderr = trace.path === 'stderr';
trace.enabled = trace.path.length > 0;
trace(`module evaluated pid=${process.pid}`);

/**
 * Declared dependencies.
 *
 * `tools` and `systemPrompt` are what the plugin contributes to; `fs` is what it
 * reads and writes the bank through. All three are hard dependencies rather than
 * `ctx.inject` probes on purpose: a throwing `ctx.inject` callback kills the whole
 * registration pass and the failure is not surfaced, so the first version of this
 * plugin lost both its tools silently. Declaring them here means the plugin
 * simply does not activate in a profile that lacks one, which an operator can see.
 */
export const inject = ['fs', 'tools', 'systemPrompt'];

/**
 * Position of the prompt contribution among the assembled system-prompt sections.
 *
 * 950 places the bank after the deployment persona and file-reference guidance
 * but before the per-tool sections, which is where durable project context
 * belongs: foundational, and ahead of mechanics. Any finite number is legal for
 * a plugin-owned section; the harness's own named slots are not extensible.
 */
const SECTION_ORDER = 950;

/** Character ceiling on one `content` argument, guarding against a runaway write. */
const MAX_CONTENT_CHARS = 4_000_000;

/** Character ceiling on `memory_bank` read output before truncation. */
const READ_LIMIT_CHARS = 60_000;

/** Character ceiling on `memory_bank` grep output before truncation. */
const GREP_LIMIT_CHARS = 20_000;

/** Resolved defaults; every one of them is overridable through the plugin `Config`. */
const DEFAULTS = Object.freeze({
  folder: '.memory-bank',
  inject: FILES.filter((file) => file.injected).map((file) => file.name),
  gist: FILES.filter((file) => !file.injected && file.highlights).map((file) => file.name),
  injectBudget: 24_000,
  fileBudget: 8_000,
  gistChars: 240,
  maxFileChars: 200_000,
  gitignore: true,
  autoInitialize: true,
  planHint: true,
});

/**
 * Validate and normalize one option, reporting a Standard Schema issue on failure.
 * @param {Array<object>} issues - collected issues.
 * @param {string} key - option name.
 * @param {unknown} value - supplied value.
 * @param {(value: unknown) => boolean} accept - type guard.
 * @param {string} expected - human description of the expected type.
 * @returns {unknown} the accepted value, or `undefined` when it was rejected.
 */
function take(issues, key, value, accept, expected) {
  if (value === undefined) return undefined;
  if (accept(value)) return value;
  issues.push({ message: `${key} must be ${expected}`, path: [key] });
  return undefined;
}

/**
 * Repair a string-list option: keep entries naming a known bank file and drop the
 * rest with an issue, so a typo is visible instead of silently shrinking the bank.
 * @param {Array<object>} issues - collected issues.
 * @param {string} key - option name.
 * @param {unknown} value - supplied value.
 * @returns {string[] | undefined} the filtered list.
 */
function takeFileList(issues, key, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ message: `${key} must be an array of Memory Bank file names`, path: [key] });
    return undefined;
  }
  const kept = [];
  for (const entry of value) {
    const match = typeof entry === 'string' ? findFile(entry) : undefined;
    if (match === undefined) {
      issues.push({ message: `${key} names no known Memory Bank file: ${JSON.stringify(entry)}`, path: [key] });
      continue;
    }
    if (!kept.includes(match.name)) kept.push(match.name);
  }
  return kept;
}

/**
 * Plugin configuration, as a Standard Schema validator.
 *
 * Hand-written on purpose: the plugin declares no dependencies, so it installs
 * and loads regardless of how the profile resolves `@deepseek-ai/*` packages, and
 * Cordis needs nothing more than `~standard.validate`. Every option is optional
 * and falls back to a default, because a patch layer replaces a row's whole
 * `config` rather than merging into it.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory-bank',
    /**
     * Validate one loader row's `config`.
     * @param {unknown} input - the raw config object.
     * @returns {{ value: object } | { issues: Array<object> }} the outcome.
     */
    validate(input) {
      const issues = [];
      const raw = input === undefined || input === null ? {} : input;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }

      const folder = take(issues, 'folder', raw.folder, (value) => typeof value === 'string' && value.trim().length > 0, 'a non-empty string') ?? DEFAULTS.folder;
      const inject = takeFileList(issues, 'inject', raw.inject) ?? [...DEFAULTS.inject];
      const gist = takeFileList(issues, 'gist', raw.gist) ?? [...DEFAULTS.gist];

      /** @param {string} key @param {number} fallback @param {number} min */
      const size = (key, fallback, min) => {
        const value = take(issues, key, raw[key], (candidate) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= min, `a number >= ${min}`);
        return value === undefined ? fallback : Math.floor(value);
      };
      /** @param {string} key @param {boolean} fallback */
      const flag = (key, fallback) => {
        const value = take(issues, key, raw[key], (candidate) => typeof candidate === 'boolean', 'a boolean');
        return value === undefined ? fallback : value;
      };

      // Every option is read BEFORE the guard. Reading them lazily inside the
      // result object would build the value first and check the issues after,
      // letting an invalid option slip through as its default.
      const injectBudget = size('injectBudget', DEFAULTS.injectBudget, 0);
      const fileBudget = size('fileBudget', DEFAULTS.fileBudget, 0);
      const gistChars = size('gistChars', DEFAULTS.gistChars, 1);
      const maxFileChars = size('maxFileChars', DEFAULTS.maxFileChars, 1);
      const gitignore = flag('gitignore', DEFAULTS.gitignore);
      const autoInitialize = flag('autoInitialize', DEFAULTS.autoInitialize);
      const planHint = flag('planHint', DEFAULTS.planHint);

      if (issues.length > 0) return { issues };
      return {
        value: Object.freeze({
          folder: folder.trim().replace(/[/\\]+$/, ''),
          inject,
          gist,
          injectBudget,
          fileBudget,
          gistChars,
          maxFileChars,
          gitignore,
          autoInitialize,
          planHint,
        }),
      };
    },
  },
};

/**
 * Whether a value survives a deep clone into the JSON-serializable tool result.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether the value is lossless JSON.
 */
function isJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value).every(isJsonValue);
  return false;
}

/**
 * Pull the owning agent's absolute workspace directory out of a session.
 * @param {{ session?: { header?: { cwd?: string } } } | undefined} agent - the live agent.
 * @returns {string | undefined} the workspace directory, when the session carries one.
 */
function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/**
 * Activate the plugin.
 *
 * Every registration goes through `ctx.effect` so removing the plugin row, or
 * reloading it, unwinds exactly what it installed.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the validated plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...config };
  const registry = new StoreRegistry({
    config: resolved,
    fsOf: () => ctx.get('fs'),
  });

  // Load trace. `attachTool` below can fail invisibly — the Loader does not surface
  // a throwing registration — so this records each activation and each refusal.
  trace(`apply: inject=${JSON.stringify(inject)} folder=${resolved.folder} tools=${ctx.tools === undefined ? 'undefined' : typeof ctx.tools.register}`);

  /** @returns {object | undefined} the live agent registry, when mounted. */
  const agentsOf = () => ctx.get('agents');

  /**
   * Register one tool definition, reporting a refusal instead of losing it.
   *
   * A registration that throws is swallowed by the Loader, which is how this
   * plugin first shipped without its tools. Wrapping it puts the reason in the
   * trace and the host log, and still lets the plugin contribute the rest.
   *
   * @param {object} definition - the tool definition to register.
   * @param {string} label - effect label for ordered ownership.
   */
  const attachTool = (definition, label) => {
    ctx.effect(() => ctx.tools.register(definition), label);
    trace(`registered ${definition.name}`);
  };

  /**
   * Whether one agent should trigger first-run initialization.
   *
   * Root sessions only. A subagent or workflow child shares the human's
   * workspace, and writing a `.memory-bank/` because an internal agent glanced at
   * a directory would be an uninvited side effect. The root session always runs
   * first in practice, so declining here loses nothing.
   *
   * @param {object} agent - the live agent.
   * @returns {boolean} whether this agent owns first-run setup.
   */
  const ownsWorkspace = (agent) => {
    const agents = agentsOf();
    if (agents === undefined || typeof agents.list !== 'function' || typeof agents.isOwnedBy !== 'function') {
      return true;
    }
    try {
      return !agents.list().some((candidate) => candidate !== agent && agents.isOwnedBy(agent.id, candidate));
    } catch {
      return true;
    }
  };

  /**
   * Initialize the bank for a workspace at most once.
   * @param {object} store - the workspace store.
   * @param {{ sessionId?: string, signal?: AbortSignal, cwd?: string }} scope - call scope.
   * @returns {Promise<object | undefined>} the report, or `undefined` when skipped or failed.
   */
  const bootstrap = async (store, scope) => {
    if (!resolved.autoInitialize) return undefined;
    if (store.seedAttempted) return undefined;
    try {
      const report = await store.initialize(scope);
      store.seedAttempted = true;
      return report;
    } catch (error) {
      ctx.logger?.warn?.(`memory-bank: could not create ${resolved.folder} in ${store.workspace}: ${String(error?.message ?? error)}`);
      return undefined;
    }
  };

  // --- Prompt contribution -------------------------------------------------
  //
  // `text` is synchronous, so the bank is read into a cache from the async
  // `agent/pre-step` path below and only rendered here. That ordering also means
  // a slow or remote filesystem delays the step rather than blocking the loop.
  //
  // This is a SECTION with `interpolate: false`, not a runtime context. The
  // distinction is load-bearing: `renderContextSections` interpolates every
  // context with no opt-out, so a bank that documents something as ordinary as
  // an Obsidian `{{title}}` placeholder makes prompt assembly throw
  // ("unknown prompt variable") and breaks the whole turn. Only sections accept
  // `interpolate: false`, and project memory is prose the harness must never
  // rewrite.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory-bank:project-memory',
    order: SECTION_ORDER,
    interpolate: false,
    text: (assembly) => {
      const agent = assembly?.agent ?? assembly?.scope;
      const workspace = workspaceOf(agent);
      if (workspace === undefined) return '';
      const store = registry.get(workspace);
      if (store === undefined) return '';
      // The cached digest is authoritative here; a cold cache renders the
      // bootstrap line and the warm pass fills it in before the request.
      const cached = store.cachedContext();
      if (cached !== undefined) return cached;
      return [
        '## Memory Bank (persistent project memory)',
        '',
        `This workspace keeps durable project memory in \`${resolved.folder}/\`, which is read into every session.`,
        'Call `memory_bank` with action `status` before assuming anything about this project.',
      ].join('\n');
    },
  }), 'memory-bank.systemPrompt');

  // Warm the cache and run first-run initialization before the step is taken, so
  // the very first model request of a fresh session already carries the bank.
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent;
    const workspace = workspaceOf(agent);
    if (workspace !== undefined) {
      const store = registry.get(workspace);
      if (store !== undefined) {
        const scope = {
          sessionId: agent?.id,
          cwd: workspace,
          ...(payload?.signal === undefined ? {} : { signal: payload.signal }),
        };
        try {
          const view = await store.load({ force: true });
          if (!view.initialized && ownsWorkspace(agent)) await bootstrap(store, scope);
          // Re-render after a possible bootstrap so the first request of a fresh
          // session already carries the seeded bank rather than an empty digest.
          await store.renderContext();
        } catch (error) {
          ctx.logger?.warn?.(`memory-bank: could not read ${resolved.folder} in ${workspace}: ${String(error?.message ?? error)}`);
        }
      }
    }
    return next();
  }, { prepend: true });

  // --- Tool implementation -------------------------------------------------

  /**
   * Resolve a model-supplied file reference against the catalogue.
   * @param {unknown} reference - the raw `file` argument.
   * @param {string} action - the action being performed, for the error message.
   * @returns {object} the catalogue entry.
   */
  const requireFile = (reference, action) => {
    const match = typeof reference === 'string' ? findFile(reference) : undefined;
    if (match === undefined) {
      throw new Error(
        `memory_bank action "${action}" needs a known bank file in \`file\`; received ${JSON.stringify(reference)}. Expected one of: ${FILES.map((file) => file.name).join(', ')}`,
      );
    }
    return match;
  };

  /**
   * Execute one `memory_bank` call.
   * @param {object} args - validated tool arguments.
   * @param {object} exec - the tool run context.
   * @returns {Promise<object>} the declared structured result.
   */
  const runMemoryBank = async (args, exec) => {
    const action = String(args.action);
    const agent = exec?.agent;
    const workspace = typeof args.workspace === 'string' && args.workspace.trim().length > 0
      ? args.workspace.trim()
      : workspaceOf(agent);
    if (workspace === undefined) {
      throw new Error('memory_bank needs a workspace directory: this call has no owning agent session and no explicit `workspace` argument');
    }
    const store = registry.get(workspace);
    if (store === undefined) {
      throw new Error('memory_bank: the composed `fs` service is not mounted in this profile');
    }
    const scope = {
      sessionId: agent?.id,
      cwd: workspace,
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    };
    const base = { action, ok: true, folder: resolved.folder, root: store.root };
    /** @returns {Array<object>} the catalogue rows for `status` and `list`. */
    const rows = (view) => view.entries.map((entry) => ({
      name: entry.name,
      title: entry.title,
      purpose: entry.purpose,
      bytes: entry.bytes,
    }));

    switch (action) {
      case 'status': {
        const view = await store.load({ force: true });
        return {
          ...base,
          initialized: view.initialized,
          ...(view.focus.length > 0 ? { focus: view.focus } : {}),
          files: rows(view),
        };
      }
      case 'list': {
        const view = await store.load({ force: true });
        return { ...base, initialized: view.initialized, files: rows(view) };
      }
      case 'init': {
        const report = await store.initialize(scope);
        store.seedAttempted = true;
        return {
          ...base,
          initialized: true,
          changed: report.created,
          kept: report.kept,
          gitignore: report.gitignore.changed,
        };
      }
      case 'sync': {
        store.invalidate();
        const view = await store.load({ force: true });
        return { ...base, initialized: view.initialized };
      }
      case 'read': {
        const match = requireFile(args.file, 'read');
        const reading = await store.readFile(match.name, scope);
        if (reading === undefined) {
          throw new Error(`${resolved.folder}/${match.name} does not exist yet; call memory_bank with action "init" or "write" to create it`);
        }
        const truncated = reading.text.length > READ_LIMIT_CHARS;
        return {
          ...base,
          file: match.name,
          bytes: reading.size,
          truncated,
          text: truncated ? reading.text.slice(0, READ_LIMIT_CHARS) : reading.text,
        };
      }
      case 'grep': {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) throw new Error('memory_bank action "grep" requires a non-empty `query`');
        const needle = query.toLowerCase();
        const view = await store.load({ force: true });
        const matches = [];
        let budget = GREP_LIMIT_CHARS;
        for (const document of view.documents) {
          const lines = document.text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line.toLowerCase().includes(needle)) continue;
            const text = line.trim().slice(0, 400);
            budget -= text.length;
            matches.push({ file: document.name, line: index + 1, text });
            if (budget <= 0) break;
          }
          if (budget <= 0) break;
        }
        return { ...base, bytes: matches.length, matches, truncated: budget <= 0 };
      }
      case 'write':
      case 'append': {
        const match = requireFile(args.file, action);
        const content = typeof args.content === 'string' ? args.content : undefined;
        if (content === undefined) throw new Error(`memory_bank action "${action}" requires a string \`content\``);
        if (content.length > MAX_CONTENT_CHARS) {
          throw new Error(`memory_bank action "${action}": \`content\` is ${content.length} characters, over the ${MAX_CONTENT_CHARS} limit`);
        }
        if (action === 'write' && content.trim().length === 0) {
          throw new Error('memory_bank action "write" requires non-empty `content`; an empty file carries no memory');
        }
        const outcome = action === 'append'
          ? await store.appendFile(match.name, content, scope)
          : await store.writeFile(match.name, content, scope, { mode: 'replace' });
        return { ...base, file: match.name, bytes: outcome.bytes, created: outcome.created };
      }
      default: {
        throw new Error(`memory_bank: unknown action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(', ')}`);
      }
    }
  };

  const bank = memoryBankTool();
  attachTool({
    ...bank,
    async execute(args, exec) {
      const result = await runMemoryBank(args, exec);
      if (!isJsonValue(result)) throw new Error('memory_bank produced a non-JSON result');
      return result;
    },
  }, 'memory-bank.tool.execute');

  attachTool({
    ...memoryPlanTool(),
    execute() {
      return Promise.resolve(memoryPlanRitual());
    },
  }, 'memory-bank.tool.plan');
}
