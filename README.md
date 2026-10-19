# dsh-memory-bank

Persistent workspace memory for DeepSeek Harness. Keeps a `.memory-bank/`
directory in the workspace and reads it into the system prompt of every session
in that workspace.

## The problem it solves

A new conversation in the same workspace starts knowing nothing. Not the stack,
not the decisions already taken, not the task that was in flight. Compaction does
not help: it shrinks a conversation that already had the information, and the new
one never did.

The Memory Bank puts that information where the project lives, and makes the
harness load it — not the prompt ask for it. That distinction is the whole design:
a bank that an agent is merely *told* to read is a bank that silently goes unread,
and nothing errors when it does.

## What it does

Installed as a bundle, it contributes three things:

| Contribution | Effect |
| --- | --- |
| A `systemPrompt.section` entry | Appends the bank digest to the system prompt of every session, resolved from the calling agent's `session.header.cwd`. A different workspace gets a different bank. |
| The `memory_bank` tool | `status`, `list`, `read`, `grep`, `write`, `append`, `init`, `sync`. All writes go through the composed `fs` service under an explicit workspace-write sandbox policy. |
| The `memory_plan` tool | Returns the update ritual: the checklist for turning a finished conversation into durable memory. |

On first use in a workspace it also creates `.memory-bank/` from templates and adds
the folder to that workspace's `.gitignore`.

## Files it maintains

Six files carry the durable project facts, and three extras hold what is only
consulted on demand.

| File | Purpose | In the prompt |
| --- | --- | --- |
| `projectbrief.md` | Goal, users, core requirements, scope | full |
| `productcontext.md` | Why it exists and how it should feel | full |
| `techcontext.md` | Stack, dependencies, environment constraints | full |
| `systempatterns.md` | Architecture, components, design patterns | full |
| `activecontext.md` | Current focus, recent changes, next steps | full |
| `progress.md` | Completed, remaining, known issues | full |
| `decisions.md` | Append-only decision log with reasoning | one-line gist |
| `glossary.md` | Ubiquitous language and naming rules | one-line gist |
| `gotchas.md` | Traps and workarounds worth remembering | one-line gist |
| `index.md` | Machine-readable manifest; can change what is injected | not injected |

`index.md` is authoritative when its table names files: an `inject` cell of `yes`
loads the whole body and `gist` loads the one-line summary, so a project can move
files between the two surfaces without touching plugin config.

`activecontext.md` is the file that matters most. Its `## Current Focus` section
supplies the one-line summary the prompt shows first, so keep that line concrete
and current.

## Configuration

Configured in the profile's `cordis.patch.yml`. A patch replaces a row's whole
`config`, so restate every option you want to change.

```yaml
- id: memory-bank
  name: dsh-memory-bank
  config:
    folder: .memory-bank        # bank directory name, relative to the workspace
    inject:                     # files whose full body enters the prompt, in order
      - projectbrief.md
      - productcontext.md
      - techcontext.md
      - systempatterns.md
      - activecontext.md
      - progress.md
    gist:                       # files represented by one summary line instead
      - decisions.md
      - glossary.md
      - gotchas.md
    injectBudget: 24000         # overall character budget; 0 disables injection
    fileBudget: 8000            # per-file character cap before truncation
    gistChars: 240              # character cap on one summary line
    maxFileChars: 200000        # character cap on one write or append
    gitignore: true             # add the folder to .gitignore on first use
    autoInitialize: true        # create the bank on first use in a workspace
    planHint: true              # mention the memory_plan ritual in the footer
```

Every option is optional and falls back to the value shown above. An unknown file
name in `inject` or `gist` is reported as a configuration issue rather than
silently dropped.

## Installing

The package is a Host-only bundle with no dependencies, no build step and no
install scripts, so the whole thing is four files of plain ESM.

```
plugin_manager { action: "install_bundle", target: "<absolute path to this package>" }
```

`install_bundle` requires an **absolute** path; a relative one is rejected. The
package must declare `dsh.bundle.patch`, which this one does.

Replacing an already-installed copy requires a **restart**: the Host caches imported
modules, HMR watches the profile config but not this package's directory, and the
Loader does not surface a module-load failure. If the tools do not appear after a
change, restart rather than debugging the plugin.

## Why it has no dependencies

The plugin imports nothing from `@deepseek-ai/*`. Two reasons:

1. **Module resolution.** A profile-installed bundle lives in
   `$DSH_HOME/profiles/<name>/node_modules`, and the harness runtime resolves from
   inside `app.asar`. A peer import that works in a source checkout can fail at
   runtime in a packaged app. Declaring no peers makes that failure mode
   impossible.
2. **Compatibility.** `Config` is a hand-written [Standard Schema][ss] validator,
   which is all Cordis needs and all the plugin requires. The cost is that the
   `Config` inspector reports the row as `unsupported` — it cannot project a
   hand-written validator into a JSON Schema for the settings UI.

[ss]: https://github.com/standard-schema/standard-schema

## Development

```sh
node dev/harness.mjs                        # 18 behavioural checks over an in-memory fs
node dev/check-schemas.mjs                  # schema conformance, dependency-free
node dev/check-schemas-against-harness.mjs  # the same schemas, real validator from app.asar
node dev/check-prompt-safety.mjs            # the {{variable}} boundary, real renderers
node dev/validate-profile-yaml.cjs <path-to-profile/cordis.patch.yml>
node dev/apply-metadata.mjs --check         # publication fields, reports drift
node dev/asar.mjs cat <path-inside-asar>    # read the packaged runtime
```

`check-prompt-safety.mjs` covers the failure mode fixed in 0.1.1: the harness
interpolates every runtime **context** with no opt-out, so project prose
containing an ordinary `{{title}}` placeholder aborted prompt assembly. The bank
is therefore contributed as a **section** with `interpolate: false`, and the
script asserts both directions against the shipped renderers — the context form
still throws the original error, while the section form passes the text through
verbatim.

`check-schemas-against-harness.mjs` reads `assertSupportedJsonSchema` straight out
of the packaged `app.asar`, because that is the authority. This matters more than
it looks: the tool registry validates every registered schema against a closed
JSON Schema subset and **throws** on a violation, and the Loader does not report
that throw — the tool simply never appears. `required: true` inside a property is
the specific spelling that trips it, since that belongs to `defineTool()`'s
authoring DSL and not to raw JSON Schema. The first draft of this plugin shipped
that mistake and lost both tools silently.

`asar.mjs` reads ordinary files too, so it doubles as a `cat` that works for both
worlds. The packaged runtime lives inside `app.asar`; a plain shell cannot list it,
but the format is a JSON header plus concatenated data, so plain Node can.

### Tracing

`DSH_MEMORY_BANK_TRACE=<path>` logs each activation and each tool registration or
refusal; `DSH_MEMORY_BANK_TRACE=stderr` writes to the host's stderr instead. It is
**off by default** — a library should not write into its own package directory,
which on a `node_modules` install belongs to the package manager.

## Design notes

- **The bank is read, not requested.** Injection happens through the prompt
  registry, so a session cannot forget to look.
- **The contribution is a section with `interpolate: false`, not a runtime
  context.** This is load-bearing: `renderContextSections` interpolates every
  context and throws on an unknown `{{name}}`, so a bank documenting, say, an
  Obsidian `{{title}}` placeholder would break prompt assembly for that whole
  workspace. Only sections can opt out, and project prose must never be rewritten
  by the harness. `dev/check-prompt-safety.mjs` asserts both halves against the
  shipped renderers.
- **The prompt path is synchronous.** `systemPrompt.section` cannot await I/O, so
  the bank is read on the async `agent/pre-step` path into a per-workspace cache
  and only rendered on the prompt path. A slow filesystem delays the step; it never
  blocks the event loop.
- **Writes are sandboxed.** Every mutation carries an explicit
  `{ mode: 'workspace-write', workspaceRoot }` policy, so the bank cannot be
  written outside the workspace even though the plugin is not a tool call.
- **Seeding is root-sessions only.** A subagent or workflow child shares the
  human's workspace; creating a `.memory-bank/` because an internal agent glanced
  at a directory would be an uninvited side effect.
- **`gitignore` is idempotent.** The check strips leading and trailing slashes and
  line endings before comparing, so `foo`, `foo/`, `/foo/` and a CRLF line all
  count as already present across plugin reloads.

## Known limitations

- No client half, so there is no Memory Bank page in the Web UI. The bank is
  edited by the agent or by hand.
- The `Config` inspector shows this row as `unsupported`, for the reason above.
- `grep` and `read` results are truncated at 20,000 and 60,000 characters. The
  truncation is reported in the result rather than being silent.
- There is no delete action: the composed `fs` service exposes no unlink, so
  removing a bank file is a filesystem operation rather than a tool call.
- `append` refuses to grow a file past `maxFileChars`, which is deliberate: it
  forces a rewrite rather than letting a log grow without bound.
- An uninitialized workspace still costs one prompt line. The contribution is empty
  until `projectbrief.md` exists, but the bootstrap line naming the tool is always
  present, because that line is what makes the uninitialized state discoverable.
- Injection is per workspace, not per session: two sessions in the same workspace
  see the same bank, which is the point, but that also means a bank edited by one
  session changes what the other sees on its next step.
