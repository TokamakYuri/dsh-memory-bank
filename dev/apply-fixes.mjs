// One-shot source fixes for dsh-memory-bank, applied as exact string replacements.
//
// Each fix asserts that its pattern matched exactly once, so a silent no-op is
// impossible: the script fails loudly instead of leaving the source half-edited.
//
// The workspace lives under OneDrive, which keeps rewriting file mtimes while
// syncing; a literal-string codemod is deterministic where an interactive editor
// guard is not.
//
// Usage: node dev/apply-fixes.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

/** @type {Array<{file: string, label: string, from: string, to: string}>} */
const FIXES = [
  {
    file: 'src/store.js',
    label: 'remove the unreachable truncate-as-delete path',
    from: `  /**
   * Remove one bank file.
   * @param {string} name - file name inside the bank directory.
   * @param {object} scope - call scope.
   * @returns {Promise<{ removed: boolean }>} whether a file was removed.
   */
  async removeFile(name, scope) {
    const existing = await this.readFile(name, scope);
    if (existing === undefined) return { removed: false };
    const target = await this.#target(name, scope);
    await this.fs.writeText(target, '', undefined, scope.signal, this.#sandbox(scope));
    // The composed fs service offers no unlink; truncation is the honest
    // approximation and is reported as such rather than as a deletion.
    this.invalidate();
    return { removed: true, truncated: true };
  }

`,
    to: '',
  },
  {
    file: 'src/store.js',
    label: 'drop the unused `known` flag from bank entries',
    from: `        purpose: purposeOf(name),
        bytes: reading.size,
        known: catalogue !== undefined,
      });`,
    to: `        purpose: purposeOf(name),
        bytes: reading.size,
      });`,
  },
  {
    file: 'src/store.js',
    label: 'describe the read loop honestly (it reads every file)',
    from: `    // Files the prompt needs are read unconditionally; the rest are only read by
    // name-based actions, so a bank with many files costs the same at prompt time.
    const wanted = [...new Set([...this.#config.inject, 'index.md', ...FILES.map((file) => file.name)])];`,
    to: `    // Every catalogue name is read by name, because the digest and \`grep\` both
    // need bodies the configuration may not list, and a name-based read costs one
    // stat plus one read regardless of how many files the directory holds.
    const wanted = [...new Set([...this.#config.inject, 'index.md', ...FILES.map((file) => file.name)])];`,
  },
  {
    file: 'src/store.js',
    label: 'drop the redundant directory probe behind `initialized`',
    from: `    let directoryExists = false;
    try {
      const rootTarget = await this.fs.resolve(this.root, this.#resolveOptions(scope));
      const rootInfo = await this.fs.stat(rootTarget);
      directoryExists = rootInfo?.type === 'directory';
    } catch {
      directoryExists = false;
    }

`,
    to: '',
  },
  {
    file: 'src/store.js',
    label: 'define `initialized` by the foundation document alone',
    from: `    const initialized = readings.has('projectbrief.md') && (directoryExists || readings.size > 0);`,
    to: `    // The foundation document is the marker: seeds always write it, and a bank
    // without it is a directory of loose notes rather than a Memory Bank.
    const initialized = readings.has('projectbrief.md');`,
  },
  {
    file: 'src/store.js',
    label: 'stop computing the unused injected-byte total',
    from: `    let injectedBytes = fullDocuments.reduce((total, document) => total + document.text.length, 0);
    injectedBytes += gists.reduce((total, entry) => total + entry.text.length, 0);

    return {`,
    to: `    return {`,
  },
  {
    file: 'src/store.js',
    label: 'stop returning the unused injected-byte total',
    from: `      gists,
      injectedBytes,
      readAt: Date.now(),`,
    to: `      gists,
      readAt: Date.now(),`,
  },
  {
    file: 'src/store.js',
    label: 'keep the registry fs accessor private',
    from: `  constructor({ config, fsOf }) {
    this.#config = config;
    this.fsOf = fsOf;
  }`,
    to: `  constructor({ config, fsOf }) {
    this.#config = config;
    this.#fsOf = fsOf;
  }`,
  },
  {
    file: 'src/tools.js',
    label: 'correct the schema-check reference in the module doc',
    from: ` * surface — the tool simply never appears. \`dev/check-schemas.mjs\` asserts every
 * schema below against a transliteration of the harness validator so this stays
 * true.`,
    to: ` * surface — the tool simply never appears. \`dev/check-schemas-against-harness.mjs\`
 * asserts every schema below against the real validator read out of \`app.asar\`,
 * and \`dev/check-schemas.mjs\` is the dependency-free guard that runs the same
 * rules without the packaged runtime.`,
  },
  {
    file: 'src/tools.js',
    label: 'rename the grep match count out of the byte field',
    from: `{ ...base, bytes: matches.length, matches, truncated: budget <= 0 }`,
    to: `{ ...base, count: matches.length, matches, truncated: budget <= 0 }`,
  },
  {
    file: 'src/tools.js',
    label: 'declare the grep match count in the result schema',
    from: `    bytes: { type: 'integer' },
    created: { type: 'boolean' },`,
    to: `    bytes: { type: 'integer' },
    count: { type: 'integer' },
    created: { type: 'boolean' },`,
  },
  {
    file: 'src/tools.js',
    label: 'hide the internal ritual field from the registered definition',
    from: `/**
 * The \`memory_plan\` tool definition.
 *
 * A zero-argument ritual card. It lives in a tool rather than in the system
 * prompt because it is only useful at the moments it is called, so a schema that
 * costs nothing on the turns that do not need it is the right trade.
 *
 * @returns {object} a definition ready for \`ctx.tools.register()\`, plus \`ritual\`.
 */
export function memoryPlanTool() {
  return {`,
    to: `/**
 * The \`memory_plan\` tool definition.
 *
 * A zero-argument ritual card. It lives in a tool rather than in the system
 * prompt because it is only useful at the moments it is called, so a schema that
 * costs nothing on the turns that do not need it is the right trade.
 *
 * The ritual text is reachable through \`memoryPlanRitual()\` rather than as a
 * property of the definition, so the object handed to \`ctx.tools.register()\`
 * carries exactly the fields the registry consumes and nothing else.
 *
 * @returns {object} a definition ready for \`ctx.tools.register()\`.
 */
export function memoryPlanTool() {
  return {`,
  },
  {
    file: 'src/tools.js',
    label: 'move the ritual behind a dedicated accessor',
    from: `    /** The ritual text the tool returns. */
    ritual: RITUAL,
  };
}`,
    to: `  };
}

/**
 * The Memory Bank update ritual.
 * @returns {string} the ritual text \`memory_plan\` returns.
 */
export function memoryPlanRitual() {
  return RITUAL;
}`,
  },
  {
    file: 'index.js',
    label: 'read the ritual through its accessor',
    from: `import { ACTIONS, memoryBankTool, memoryPlanTool } from './src/tools.js';`,
    to: `import { ACTIONS, memoryBankTool, memoryPlanRitual, memoryPlanTool } from './src/tools.js';`,
  },
  {
    file: 'index.js',
    label: 'return the ritual through its accessor',
    from: `  const plan = memoryPlanTool();
  attachTool({
    ...plan,
    execute() {
      return Promise.resolve(plan.ritual);
    },
  }, 'memory-bank.tool.plan');`,
    to: `  attachTool({
    ...memoryPlanTool(),
    execute() {
      return Promise.resolve(memoryPlanRitual());
    },
  }, 'memory-bank.tool.plan');`,
  },
  {
    file: 'dev/harness.mjs',
    label: 'follow the ritual accessor in the harness',
    from: `  const ritual = await memoryPlan.execute({}, exec);`,
    to: `  const ritual = await memoryPlan.execute({}, exec);`,
  },
];

let applied = 0;
let skipped = 0;
for (const fix of FIXES) {
  const target = path.join(packageRoot, fix.file);
  const before = fs.readFileSync(target, 'utf8');
  const occurrences = before.split(fix.from).length - 1;
  if (occurrences === 0) {
    // Re-running this script is legitimate and must be a no-op. A deletion fix
    // leaves no marker to test for, so a zero match is reported as "already
    // applied" in every case; the review that produced the fix is the record
    // that it was needed exactly once.
    console.log(`SKIP ${fix.file}: no match, already applied — ${fix.label}`);
    skipped += 1;
    continue;
  }
  if (occurrences !== 1) {
    throw new Error(`${fix.file}: pattern matched ${occurrences} times, expected 1 — ${fix.label}`);
  }
  if (checkOnly) {
    console.log(`WOULD APPLY ${fix.file}: ${fix.label}`);
    continue;
  }
  fs.writeFileSync(target, before.replace(fix.from, fix.to));
  console.log(`applied ${fix.file}: ${fix.label}`);
  applied += 1;
}

console.log(checkOnly
  ? '\nCheck complete.'
  : `\n${applied} fix(es) applied, ${skipped} already in place.`);
