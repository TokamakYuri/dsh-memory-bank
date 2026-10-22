# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.2] - 2026-10-22

### Fixed

- **The optional `workspace` argument no longer produces phantom "missing files"
  in other projects.** It was used verbatim, so an agent pointing at "the memory
  bank" — passing either the bank directory itself or a bare `.memory-bank` — made
  the store look for `<that path>/.memory-bank/*.md`, find nothing, and report every
  file as absent. A relative path was worse: it resolved against the Host process
  directory, with the same silent result. Now:
  - a path naming the bank directory is understood to mean its parent;
  - a relative path is refused, with a message naming the session workspace;
  - every result echoes the resolved `workspace`, and `status` / `list` name the
    directory they searched when it holds nothing;
  - a `read` of an absent file names the resolved bank root, so a path mismatch
    reads as a path mismatch instead of as a file that was never created.
- `dev/real-fs-smoke.mjs` runs the plugin against the real filesystem over a copy
  of another workspace's bank, and `dev/check-workspace-argument.mjs` pins the
  argument handling above. Both other workspaces on this machine pass all checks.

## [0.1.1] - 2026-10-20

### Fixed

- **A bank containing `{{...}}` no longer breaks prompt assembly.** The digest was
  injected as a `systemPrompt.context`, and the harness interpolates every runtime
  context with no opt-out, throwing `unknown prompt variable "{{title}}"` on any
  unknown reference. A bank that documented something as ordinary as an Obsidian
  template placeholder therefore failed the whole turn for that workspace. The
  contribution is now a section registered with `interpolate: false`, which the
  harness honours, so bank prose reaches the model verbatim.
- `dev/check-prompt-safety.mjs` reproduces the original failure against the shipped
  renderers and asserts the section form survives it, so the behaviour is pinned
  rather than assumed.

## [0.1.0] - 2026-10-14

First release.

### Added

- A `systemPrompt.context` contribution that injects the workspace Memory Bank
  into every session in that workspace, resolved from `session.header.cwd`, so
  the same workspace gets the same memory and a different one gets its own.
- The `memory_bank` tool with eight actions: `status`, `list`, `read`, `grep`,
  `write`, `append`, `init`, and `sync`.
- The `memory_plan` tool, returning the update ritual for turning a finished
  conversation into durable project memory.
- First-run seeding of `.memory-bank/` with ten files: the six core documents
  (`projectbrief.md`, `productcontext.md`, `techcontext.md`,
  `systempatterns.md`, `activecontext.md`, `progress.md`) plus `decisions.md`,
  `glossary.md`, `gotchas.md`, and the `index.md` manifest.
- `.gitignore` handling that adds the bank folder on first use, idempotently and
  across every spelling git accepts, including a CRLF line ending.
- `index.md` as the injection manifest: an `inject` cell of `yes` loads a file's
  body and `gist` loads its one-line summary, so a project can change the prompt
  surface without touching plugin configuration.
- Ten plugin configuration options, all optional: `folder`, `inject`, `gist`,
  `injectBudget`, `fileBudget`, `gistChars`, `maxFileChars`, `gitignore`,
  `autoInitialize`, and `planHint`.
- Four development scripts: a behavioural harness over an in-memory filesystem,
  a dependency-free schema check, the same schema check against the real
  validator read out of the packaged harness, and a profile-YAML validator.

### Design notes

- No dependencies and no build step: the package imports nothing from
  `@deepseek-ai/*`, because a profile-installed bundle resolves modules
  differently from a source checkout. `Config` is a hand-written
  [Standard Schema](https://github.com/standard-schema/standard-schema)
  validator, which is all Cordis requires.
- Every mutation runs through the composed `fs` service under an explicit
  `workspace-write` sandbox policy, so the bank cannot be written outside the
  workspace.
- Seeding is limited to root sessions, so an internal subagent never creates a
  bank as a side effect of reading a directory.

### Fixed during development

These were found by review before the first release and never shipped:

- Tool schemas were written in `defineTool()`'s authoring DSL (`required: true`
  inside a property) instead of raw JSON Schema. The registry threw, the Loader
  did not report it, and both tools were silently absent.
- `.gitignore` duplicate detection was a no-op expression, so a plugin reload
  appended a second entry.
- `Config.validate` read its options lazily inside the result object, checking
  for issues before the options were validated and letting an invalid value
  through as its default.
- Load tracing was on by default and wrote into the package directory.
- `grep` returned its match count in a field named `bytes`.

[Unreleased]: https://github.com/TokamakYuri/dsh-memory-bank/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/TokamakYuri/dsh-memory-bank/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/TokamakYuri/dsh-memory-bank/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TokamakYuri/dsh-memory-bank/releases/tag/v0.1.0
