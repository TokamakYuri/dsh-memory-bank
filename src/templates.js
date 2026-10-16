/**
 * Memory Bank file catalogue and first-run templates.
 *
 * The bank is a directory of small, single-purpose Markdown files hand-edited by
 * the agent and read verbatim into the system prompt. The catalogue below is the
 * single source of truth for file names, purpose, aliases and injection defaults.
 *
 * Ordering rule (the reason the hierarchy matters): `projectbrief.md` is the
 * foundation, `productcontext.md` / `systempatterns.md` / `techcontext.md` derive
 * from it, `activecontext.md` derives from all of them, and `progress.md` tracks
 * state. Templates are written to disk verbatim, so keep them short: a template
 * that is cheap to read is a template the agent actually keeps current.
 *
 * @module dsh-memory-bank/templates
 */

/** Heading marker that precedes the one-line summary used by the prompt digest. */
export const FOCUS_HEADING = '## Current Focus';

/**
 * The files the bank owns. `injected` files are the default prompt surface;
 * `highlights` files contribute a one-line gist instead of their full body.
 * @type {ReadonlyArray<{
 *   name: string,
 *   title: string,
 *   purpose: string,
 *   injected: boolean,
 *   highlights: boolean,
 *   template: string,
 * }>}
 */
export const FILES = Object.freeze([
  {
    name: 'projectbrief.md',
    title: 'Project Brief',
    purpose: 'The foundation: what we are building, for whom, and the non-negotiable requirements.',
    injected: true,
    highlights: false,
    template: `# Project Brief

> The foundation document. Every other Memory Bank file derives from this one.
> Keep it short and stable; change it only when the project's goal actually changes.

**Last updated**: (not yet recorded)

## Goal

<One or two sentences: what this project is and what "done" means.>

## Target Users

<Who uses it, and in what situation.>

## Core Requirements

<The handful of things that must be true. Rank them; do not list features here.>

1.
2.
3.

## Success Criteria

<How we will know it works. Prefer observable, checkable statements.>

## Out of Scope

<What this project deliberately does not do. This section prevents the most rework.>

## Open Questions

<Unknowns that block or reshape the work. Move answers into the sections above.>
`,
  },
  {
    name: 'productcontext.md',
    title: 'Product Context',
    purpose: 'Why the project exists, the problem it solves, and how it should feel to use.',
    injected: true,
    highlights: false,
    template: `# Product Context

> Why this exists, and what the experience should be. Derives from \`projectbrief.md\`.

**Last updated**: (not yet recorded)

## Problem

<The pain that motivates the project. Describe the world without it.>

## Why It Matters

<The value created, and for whom. Why now.>

## Intended Experience

<How it should feel to use. Behaviour and tone, not implementation.>

## Key User Journeys

<The two or three paths that must work well. Name the steps.>

## Alternatives Considered

<What people do today instead, including doing nothing, and why that is worse.>
`,
  },
  {
    name: 'techcontext.md',
    title: 'Tech Context',
    purpose: 'The technology stack, dependencies, and the constraints the environment imposes.',
    injected: true,
    highlights: false,
    template: `# Tech Context

> The stack as it actually is, not as it was planned. Derives from \`projectbrief.md\`.
> New sessions read this first when asked "what is this built with?", so keep it exact.

**Last updated**: (not yet recorded)

## Languages and Runtimes

| Layer | Choice | Version | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Frameworks and Libraries

<Direct dependencies that shape the design. Note why each was chosen if non-obvious.>

## Build, Test and Run

\`\`\`text
install:
dev:
test:
build:
lint:
\`\`\`

## Environment and Constraints

<OS targets, runtime version pins, required environment variables, sandbox or
network limits, licence constraints, hardware assumptions.>

## External Services

<APIs, databases, queues, third-party platforms, and how they are configured.>

## Deliberate Non-Choices

<Technologies explicitly rejected, with the one-line reason. Stops the same
proposal from being re-litigated in every new conversation.>
`,
  },
  {
    name: 'systempatterns.md',
    title: 'System Patterns',
    purpose: 'Architecture, key components, data flow, and the design patterns in use.',
    injected: true,
    highlights: false,
    template: `# System Patterns

> How the system is built. Derives from \`projectbrief.md\`.

**Last updated**: (not yet recorded)

## Architecture

<The shape of the system in a few lines. Prefer a small ASCII diagram over prose.>

\`\`\`text
<component> -> <component> -> <component>
\`\`\`

## Key Components

| Component | Responsibility | Location |
| --- | --- | --- |
|  |  |  |

## Data Flow

<How a request, event or record travels through the system, step by step.>

## Design Patterns in Use

<Named patterns and where they are applied, so new code matches existing code.>

## Boundaries and Contracts

<What each module promises the others, and what it must not know about.>

## Conventions

<Naming, file layout, error handling, logging. Anything a reviewer would flag.>
`,
  },
  {
    name: 'activecontext.md',
    title: 'Active Context',
    purpose: 'The current focus, the most recent changes, and the immediate next steps.',
    injected: true,
    highlights: false,
    template: `# Active Context

> The most volatile file, and the most valuable to a fresh session. Update it at
> the end of every working session. Derives from every other file.

**Last updated**: (not yet recorded)

## Current Focus

<ONE sentence naming the single thing being worked on right now. The Memory Bank
extracts this line into the system prompt, so keep it on one line and concrete.>

## Recent Changes

<Newest first. What changed, and why. Include files or areas touched.>

-

## Next Steps

<Ordered. The first item is what a new session should pick up.>

1.

## Active Decisions

<Choices currently in force that shape the work, with a pointer to the record in
\`decisions.md\` when one exists.>

## Open Questions and Blockers

<What is unresolved, and who or what can resolve it.>

## Working Notes

<Scratch space for the current task: hypotheses, dead ends, commands worth
re-running. Prune it once the task closes.>
`,
  },
  {
    name: 'progress.md',
    title: 'Progress',
    purpose: 'What is complete, what remains to be built, and the known issues.',
    injected: true,
    highlights: false,
    template: `# Progress

> State of the build. Derives from \`projectbrief.md\` and tracks everything.

**Last updated**: (not yet recorded)

## Status Summary

<One or two lines a newcomer can act on.>

## Completed

<Newest first. Only things that are actually finished and verified.>

-

## Remaining

<What is left, ordered by what unblocks the most. Mark the current item.>

- [ ]

## Known Issues

| Issue | Impact | Workaround | Status |
| --- | --- | --- | --- |
|  |  |  |  |

## Verification State

<How each major area is known to work: which tests, which manual checks, what has
never been run. Distinguish "tested" from "assumed".>

## Milestones

| Milestone | State | Notes |
| --- | --- | --- |
|  |  |  |
`,
  },
  {
    name: 'decisions.md',
    title: 'Decisions',
    purpose: 'Append-only log of technical decisions and the reasoning behind them.',
    injected: false,
    highlights: true,
    template: `# Decisions

> Append-only. Never rewrite history: supersede an entry instead. This file is why
> a new session stops re-proposing something that was already rejected.

**Last updated**: (not yet recorded)

## Format

\`\`\`markdown
### D-000 - <short title>
- **Status**: proposed | accepted | superseded by D-000 | rejected
- **Date**: YYYY-MM-DD
- **Context**: the forces at play, in two or three lines
- **Decision**: what was decided, in the active voice
- **Consequences**: what becomes easier, what becomes harder, what is now fixed
\`\`\`

---

### D-001 - Adopt the Memory Bank

- **Status**: accepted
- **Date**: (not yet recorded)
- **Context**: work spans many conversations, and each new one started without the
  stack, the past decisions or the current task.
- **Decision**: keep the durable project facts in \`.memory-bank/\` and read them
  into every session.
- **Consequences**: the bank must be kept current, or it becomes actively
  misleading. \`activecontext.md\` and \`progress.md\` are the files that rot first.
`,
  },
  {
    name: 'glossary.md',
    title: 'Glossary',
    purpose: 'Ubiquitous language: domain terms, and the words this project avoids.',
    injected: false,
    highlights: true,
    template: `# Glossary

> One definition per term, in the project's own vocabulary. When code and
> conversation use the same word for the same thing, ambiguity disappears.

**Last updated**: (not yet recorded)

## Terms

| Term | Meaning | Avoid saying |
| --- | --- | --- |
|  |  |  |

## Naming Rules

<Identifiers, casing, prefixes, and any word with a reserved meaning here.>
`,
  },
  {
    name: 'gotchas.md',
    title: 'Gotchas',
    purpose: 'Traps, footguns and hard-won workarounds that are easy to rediscover the hard way.',
    injected: false,
    highlights: true,
    template: `# Gotchas

> Every entry here cost someone time once. Add an entry the moment a surprise
> costs more than a few minutes, so it only costs that once.

**Last updated**: (not yet recorded)

## Entries

### <short symptom>

- **Symptom**:
- **Cause**:
- **Workaround**:
- **Seen**: YYYY-MM-DD

## Environment Quirks

<Platform differences, tooling bugs, flaky commands, commands that must not be run.>
`,
  },
  {
    name: 'index.md',
    title: 'Index',
    purpose: 'Machine-readable manifest of the bank: order, and what each file is for.',
    injected: false,
    highlights: false,
    template: `# Memory Bank Index

<!--
This table tells the Memory Bank plugin which files exist and which ones enter the
system prompt. \`inject: yes\` means the full body is loaded (subject to the size
cap); \`inject: gist\` means only the one-line summary is loaded. Change this table
when you add or repurpose a file.
-->

| File | Purpose | Inject |
| --- | --- | --- |
| projectbrief.md | Goal, users, core requirements, scope | yes |
| productcontext.md | Why it exists and how it should feel | yes |
| techcontext.md | Stack, dependencies, environment constraints | yes |
| systempatterns.md | Architecture, components, design patterns | yes |
| activecontext.md | Current focus, recent changes, next steps | yes |
| progress.md | Completed, remaining, known issues | yes |
| decisions.md | Append-only decision log with reasoning | gist |
| glossary.md | Ubiquitous language and naming rules | gist |
| gotchas.md | Traps and workarounds worth remembering | gist |

## Reading Order

1. \`projectbrief.md\` - the foundation
2. \`productcontext.md\`, \`systempatterns.md\`, \`techcontext.md\` - derived context
3. \`activecontext.md\` - where the work stands today
4. \`progress.md\` - what is done and what is left
5. \`decisions.md\`, \`glossary.md\`, \`gotchas.md\` - consult on demand
`,
  },
]);

/** Fast lookup by exact file name. */
const BY_NAME = new Map(FILES.map((file) => [file.name, file]));

/** Lower-cased lookup for tolerant file addressing (`ActiveContext.md`, `progress`). */
const BY_LOOSE_NAME = new Map();
for (const file of FILES) {
  BY_LOOSE_NAME.set(file.name.toLowerCase(), file);
  BY_LOOSE_NAME.set(file.name.toLowerCase().replace(/\.md$/, ''), file);
}

/**
 * Resolve a model-supplied file reference to a catalogue entry.
 * @param {string} reference - file name, with or without the `.md` suffix.
 * @returns {typeof FILES[number] | undefined} the matching entry.
 */
export function findFile(reference) {
  const key = String(reference ?? '').trim().toLowerCase();
  return BY_LOOSE_NAME.get(key) ?? (key.endsWith('.md') ? undefined : BY_LOOSE_NAME.get(`${key}.md`));
}

/** Every file name the bank owns, in catalogue order. */
export const FILE_NAMES = Object.freeze(FILES.map((file) => file.name));

/** The default prompt surface: full bodies for the core six. */
export const DEFAULT_INJECTED = Object.freeze(
  FILES.filter((file) => file.injected).map((file) => file.name),
);

/**
 * The canonical first-run files, keyed by name, ready to be written verbatim.
 * @returns {ReadonlyArray<{ name: string, content: string }>} template contents.
 */
export function initialFiles() {
  return FILES.map((file) => ({ name: file.name, content: file.template }));
}

/**
 * Parse `index.md` for a user-maintained injection list.
 *
 * Recognizes the `| file | purpose | inject |` table. A cell of `yes`, `full`,
 * `true` or `1` means "inject the body"; `gist`, `summary` or `highlights` means
 * "inject the one-line summary"; anything else means "does not enter the prompt".
 * Unparseable indexes yield an empty list so the caller falls back to defaults
 * rather than silently dropping the prompt surface.
 *
 * @param {string} markdown - raw `index.md` content.
 * @returns {{ full: string[], gist: string[] }} explicit injection lists.
 */
export function parseIndexInjections(markdown) {
  const full = [];
  const gist = [];
  const seen = new Set();
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // Leading and trailing empty cells come from the outer pipes.
    const [, file = '', , inject = ''] = cells;
    if (!/\.md$/i.test(file) || file.toLowerCase() === 'file') continue;
    if (/^-+$/.test(file)) continue;
    const match = findFile(file);
    if (match === undefined || seen.has(match.name)) continue;
    const verdict = inject.toLowerCase();
    if (verdict === 'yes' || verdict === 'full' || verdict === 'true' || verdict === '1') {
      full.push(match.name);
      seen.add(match.name);
    } else if (verdict === 'gist' || verdict === 'summary' || verdict === 'highlights') {
      gist.push(match.name);
      seen.add(match.name);
    }
  }
  return { full, gist };
}

/**
 * Extract the one-line summary that represents a file in the prompt digest.
 *
 * Prefers the `## Current Focus` body, then the first non-empty non-heading,
 * non-blockquote line, so a hand-written bank still yields something useful
 * without following the template exactly.
 *
 * @param {string} markdown - raw file content.
 * @param {number} maxChars - hard cap on the returned gist.
 * @returns {string} one line, or an empty string when the file carries no prose.
 */
export function summarize(markdown, maxChars = 240) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const focusAt = lines.findIndex((line) => line.trim() === FOCUS_HEADING);
  const candidates = focusAt === -1 ? lines : [...lines.slice(focusAt + 1), ...lines];
  for (const raw of candidates) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('>')) continue;
    if (line.startsWith('|')) continue;
    if (line.startsWith('```')) continue;
    if (/^\**Last updated\**\s*:/i.test(line)) continue;
    if (/^<.*>$/.test(line)) continue;
    const flat = line.replace(/^[-*\d.]+\s*/, '').replace(/\*\*/g, '').trim();
    if (flat.length === 0) continue;
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}\u2026`;
  }
  return '';
}

/**
 * Human-readable purpose for one file name, falling back to a generic line.
 * @param {string} name - file name.
 * @returns {string} the catalogue purpose.
 */
export function purposeOf(name) {
  return BY_NAME.get(name)?.purpose ?? 'Project memory maintained by the agent.';
}
