/**
 * Tool schema definitions for the Memory Bank plugin.
 *
 * These are raw JSON Schema documents in the enforced subset that
 * `ctx.tools.register()` validates against: a closed type union, object-rooted
 * parameters with `required` as an ARRAY of property names, and only
 * `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` /
 * `enum` / `const` plus the `description` / `title` / `default` / `examples`
 * annotations.
 *
 * That subset is stricter than it looks: the `required: true` spelling that
 * `defineTool()`'s authoring DSL accepts is NOT valid raw JSON Schema, and
 * anything outside the subset throws at registration, which the Loader does not
 * surface — the tool simply never appears. `dev/check-schemas-against-harness.mjs`
 * asserts every schema below against the real validator read out of `app.asar`,
 * and `dev/check-schemas.mjs` is the dependency-free guard that runs the same
 * rules without the packaged runtime.
 *
 * Descriptions are written for a model deciding *whether* to call, so they state
 * the trigger, not just the mechanism.
 *
 * @module dsh-memory-bank/tools
 */

/** Action names accepted by the `memory_bank` tool, in the order they are documented. */
export const ACTIONS = Object.freeze([
  'status',
  'read',
  'write',
  'append',
  'list',
  'grep',
  'init',
  'sync',
]);

/**
 * Shared parameter description for the bank-relative file name.
 * @param {string} extra - trailing sentence appended to the shared description.
 * @returns {string} the composed description.
 */
function fileDescription(extra) {
  return [
    'Bank-relative file name, for example "techcontext.md".',
    'The catalogue is: projectbrief.md (goal, users, requirements), productcontext.md (why it exists),',
    'techcontext.md (stack, dependencies, environment), systempatterns.md (architecture, patterns),',
    'activecontext.md (current focus, recent changes, next steps), progress.md (done, remaining, issues),',
    'decisions.md (append-only decision log), glossary.md (ubiquitous language), gotchas.md (traps and workarounds).',
    extra,
  ].filter((part) => part.length > 0).join(' ');
}

/** One file row in the `status` and `list` results. */
const FILE_ROW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'title', 'purpose', 'bytes'],
  properties: {
    name: { type: 'string' },
    title: { type: 'string' },
    purpose: { type: 'string' },
    bytes: { type: 'integer' },
  },
});

/** One `grep` hit. */
const MATCH_ROW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'text'],
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    text: { type: 'string' },
  },
});

/**
 * The result schema shared by every `memory_bank` action.
 *
 * One flat object with optional action-specific fields, because a tool declares
 * exactly one result schema and the registry validates every action's return
 * against it. `action`, `ok`, `folder` and `root` are always present; the rest
 * belong to the action that fills them in.
 */
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'ok', 'folder', 'root'],
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    ok: { type: 'boolean' },
    folder: { type: 'string' },
    root: { type: 'string' },
    initialized: { type: 'boolean' },
    focus: { type: 'string' },
    file: { type: 'string' },
    bytes: { type: 'integer' },
    count: { type: 'integer' },
    created: { type: 'boolean' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    changed: { type: 'array', items: { type: 'string' } },
    kept: { type: 'array', items: { type: 'string' } },
    gitignore: { type: 'boolean' },
    matches: { type: 'array', items: MATCH_ROW_SCHEMA },
    files: { type: 'array', items: FILE_ROW_SCHEMA },
  },
});

/**
 * The Memory Bank update ritual, as one markdown card. Returned by `memory_plan`
 * and kept here so the tool and its payload cannot drift.
 */
const RITUAL = [
  '# Memory Bank update ritual',
  '',
  'Run this when a unit of work ends, when the user says "update memory bank" or "UMB",',
  'or before you expect the conversation to be abandoned.',
  '',
  '## 1. Answer four questions from what actually happened',
  '',
  "- What changed in the project's goal or scope? -> `projectbrief.md`",
  '- What did we decide, and why? -> `decisions.md` (append) and `activecontext.md`',
  '- What did we finish, and what is still broken? -> `progress.md`',
  '- Where does the next session start? -> `activecontext.md`',
  '',
  '## 2. Update in this order',
  '',
  '1. `progress.md` — move finished items to Completed, add what remains, record new issues and',
  '   add anything you verified but never wrote down.',
  '2. `activecontext.md` — rewrite Current Focus as ONE concrete sentence, list Recent Changes',
  "   newest first, and make Next Steps ordered with the next session's first action at the top.",
  '3. `decisions.md` — append one entry per real decision, with context and consequences.',
  '   Supersede an old entry by status; never rewrite it.',
  '4. `techcontext.md` — update only when the stack, a version, a command or a constraint moved.',
  '5. `systempatterns.md` — update when the architecture or a convention changed.',
  '6. `gotchas.md` — append anything that cost real time to discover.',
  '7. `projectbrief.md` and `productcontext.md` — usually stable; touch only on a real pivot.',
  '',
  '## 3. Rules that keep the bank alive',
  '',
  '- Write durable facts, not a diary. "Chose SQLite for the queue because it ships with Node" is',
  '  memory; "ran the tests" is not.',
  '- Rewrite a file in full with `write`; use `append` only for `decisions.md` and `gotchas.md`.',
  '- Keep each file short enough to read in one go. If it grew past a screenful, summarise it.',
  '- Delete what is no longer true. A stale bank is worse than no bank.',
  '- Honestly separate verified from assumed, especially in `progress.md`.',
  '- Record the reasoning, not just the outcome: the next session needs to know why, or it will',
  '  re-propose what you already rejected.',
  '- Do not summarise the whole project: update only what this conversation actually changed.',
  '',
  '## 4. Finish',
  '',
  'Call `memory_bank` with action `sync`, then tell the user in one or two lines which files you',
  'changed and what the next session will pick up.',
].join('\n');

/**
 * The `memory_bank` tool definition.
 * @returns {object} a definition ready for `ctx.tools.register()`.
 */
export function memoryBankTool() {
  return {
    name: 'memory_bank',
    description: [
      'Read and maintain the workspace Memory Bank: the durable project memory in `.memory-bank/`',
      'that lets a NEW conversation in this workspace inherit the tech stack, the decisions already',
      'made, and the task in flight.',
      '',
      'Use it because the bank is not free-form notes: it is read into the system prompt of every',
      'session in this workspace, so what you write here is what the next session knows, and what you',
      'leave out is what it gets wrong.',
      '',
      'Call it when: a session starts and `status` shows an uninitialized bank; you make or discover an',
      'architectural decision (`append` to decisions.md); the stack, a dependency or an environment',
      'constraint changes (`write` techcontext.md); you finish a unit of work (update progress.md and',
      'activecontext.md); you hit a trap worth remembering (`append` gotchas.md); or the user says',
      '"remember this".',
      '',
      'Keep files short and current. Rewrite a file in full with `write` rather than appending endlessly;',
      'reserve `append` for the genuinely append-only logs such as decisions.md. Prefer recording one',
      'durable fact over narrating what you did.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: [
            'status (default check: initialized?, current focus, per-file size — start here),',
            'read (full text of one file),',
            'write (replace one file\'s complete content),',
            'append (add a section to the end of one file),',
            'list (every file with purpose and size),',
            'grep (case-insensitive search across all bank files with line numbers),',
            'init (create .memory-bank/ with template files and add it to .gitignore; never overwrites),',
            'sync (drop cached reads so the next prompt injection reflects disk immediately).',
          ].join(' '),
        },
        file: {
          type: 'string',
          description: fileDescription('Required for read, write and append.'),
        },
        content: {
          type: 'string',
          description: 'Complete new file body for write, or the section to add for append. Required for both.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive search term for grep. Required for grep.',
        },
        workspace: {
          type: 'string',
          description: 'Absolute workspace directory to operate on. Omit to use the current session workspace, which is almost always what you want.',
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => {
        const lines = [];
        const where = `\`${value.folder}/\` (${value.root})`;
        switch (value.action) {
          case 'status': {
            lines.push(
              value.initialized
                ? `Memory Bank at ${where} is initialized${value.focus ? ` — current focus: ${value.focus}` : ''}.`
                : `Memory Bank at ${where} is NOT initialized. Call this tool with action "init" to create it.`,
            );
            for (const file of value.files ?? []) {
              lines.push(`- ${file.name} (${file.bytes} B) — ${file.purpose}`);
            }
            break;
          }
          case 'list': {
            lines.push(`Memory Bank at ${where}:`);
            for (const file of value.files ?? []) lines.push(`- ${file.name} (${file.bytes} B) — ${file.purpose}`);
            if ((value.files ?? []).length === 0) lines.push('- (no files yet)');
            break;
          }
          case 'read': {
            lines.push(value.truncated === true
              ? `Read \`${value.folder}/${value.file}\` (truncated; read the file directly for the rest):`
              : `Read \`${value.folder}/${value.file}\`:`);
            lines.push('', value.text ?? '');
            break;
          }
          case 'grep': {
            const matches = value.matches ?? [];
            lines.push(matches.length === 0
              ? 'No Memory Bank file matches that query.'
              : `${matches.length} match${matches.length === 1 ? '' : 'es'} in the Memory Bank:`);
            for (const match of matches) lines.push(`${match.file}:${match.line}: ${match.text}`);
            break;
          }
          case 'write':
          case 'append': {
            lines.push(`${value.created === true ? 'Created' : 'Updated'} \`${value.folder}/${value.file}\` (${value.bytes} B).`);
            break;
          }
          case 'init': {
            lines.push(`Memory Bank created at ${where}.`);
            if ((value.changed ?? []).length > 0) lines.push(`- created: ${(value.changed ?? []).join(', ')}`);
            if ((value.kept ?? []).length > 0) lines.push(`- already present, left alone: ${(value.kept ?? []).join(', ')}`);
            lines.push(`- .gitignore ${value.gitignore === true ? 'now ignores this folder' : 'already ignored this folder'}`);
            lines.push('', 'Fill in projectbrief.md and activecontext.md first: the other files derive from them.');
            break;
          }
          case 'sync': {
            lines.push(`Memory Bank cache dropped for \`${value.folder}\`; the next prompt reflects disk immediately.`);
            break;
          }
          default: {
            lines.push(`${value.action} on ${where}: ${value.ok === true ? 'ok' : 'failed'}.`);
          }
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    /**
     * Memory Bank reads are workspace-scoped and independent. The registry
     * defaults to exclusive, so declare the safe cases rather than serialising
     * every read behind an unrelated write.
     * @param {unknown} args - the raw call arguments.
     * @returns {boolean} whether the call may run beside others.
     */
    isConcurrencySafe(args) {
      const action = typeof args === 'object' && args !== null && 'action' in args
        ? String(args.action)
        : '';
      return action === 'read' || action === 'list' || action === 'grep' || action === 'status';
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Memory Bank: ${String(args.action)}`,
      kind: args.action === 'write' || args.action === 'append' || args.action === 'init' ? 'edit' : 'read',
      rawInput: args.file === undefined ? { action: args.action } : { action: args.action, file: args.file },
    }),
  };
}

/**
 * The `memory_plan` tool definition.
 *
 * A zero-argument ritual card. It lives in a tool rather than in the system
 * prompt because it is only useful at the moments it is called, so a schema that
 * costs nothing on the turns that do not need it is the right trade.
 *
 * The ritual text is reachable through `memoryPlanRitual()` rather than as a
 * property of the definition, so the object handed to `ctx.tools.register()`
 * carries exactly the fields the registry consumes and nothing else.
 *
 * @returns {object} a definition ready for `ctx.tools.register()`.
 */
export function memoryPlanTool() {
  return {
    name: 'memory_plan',
    description: [
      'Return the Memory Bank update ritual: the checklist for turning what just happened in this',
      'conversation into durable project memory.',
      '',
      'Call it at the end of a work session, when the user asks to update or save the memory bank,',
      'or before a long task is expected to hand off to a new conversation. It returns instructions',
      'only — it changes no files; apply them with `memory_bank`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({
      card: 'generic',
      title: 'Memory Bank update ritual',
      kind: 'read',
    }),
  };
}

/**
 * The Memory Bank update ritual.
 * @returns {string} the ritual text `memory_plan` returns.
 */
export function memoryPlanRitual() {
  return RITUAL;
}
