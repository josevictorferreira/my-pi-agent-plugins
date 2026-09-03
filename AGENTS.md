# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-24, updated 2026-09-02
**Commit:** edd5321 (+ uncommitted skill-state)
**Branch:** main

## OVERVIEW
Single Bun/TypeScript pi package containing eight independently loaded extensions. Pi loads `extensions/*/index.ts` through jiti; there is no build step and the repository has one root package boundary.

## STRUCTURE
```text
.
├── extensions/              # loadable pi extensions
│   ├── codegraph/            # CodeGraph CLI-backed semantic exploration
│   ├── context7/             # Context7 documentation API client
│   ├── hindsight/            # Hindsight memory API and automatic retention
│   ├── lsp/                  # language-server client, configuration, and pi hooks
│   ├── skill-state/          # SKILL.state runtime: /state-run bounded-state agent loop
│   ├── stt/                  # microphone dictation into the prompt via Velox
│   ├── tts/                  # spoken summary of the last reply via Velox
│   └── web-tools/            # Velox web search and URL extraction
├── .agents/plans/            # tracked design plans
├── .agents/specs/            # reviewed implementation specs (skill-state)
├── package.json              # pi package metadata and check script
├── tsconfig.json             # strict no-emit TypeScript configuration
└── README.md                 # package and plugin documentation
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| Add or change a plugin tool | `extensions/<plugin>/index.ts` | Each entry point default-exports `(pi: ExtensionAPI) => void`. |
| Understand a plugin contract | `extensions/<plugin>/README.md` | Documents tool parameters, environment variables, and external API behavior. |
| Change language-server lifecycle | `extensions/lsp/index.ts` | Lazy client startup, edit/write diagnostics, `lsp` tool, `/lsp`, shutdown cleanup. |
| Change JSON-RPC or diagnostics state | `extensions/lsp/client.ts` | Hand-rolled stdio framing, requests, notifications, file sync, pushed diagnostics. |
| Change server catalog/config merging | `extensions/lsp/servers.ts` | Built-ins, trusted project config, root discovery, validation. |
| Change package/typechecking setup | `package.json`, `tsconfig.json` | Only script is `bun run check`; compiler includes `extensions`. |
| Understand installation/loading | `README.md`, `package.json` | `pi.extensions` points at `./extensions`; plugins ship without local dependencies. |
| Understand or change the spoken-summary flow | `extensions/tts/index.ts` | `/speak` command and `ctrl+alt+s` shortcut; Velox chat summary + audio speech, local playback. |
| Understand or change the dictation flow | `extensions/stt/index.ts` | `/dictate` command and `ctrl+alt+d` shortcut; local recording via `pw-record`/`ffmpeg`, Velox transcription, transcript appended to the prompt editor. |
| Understand the SKILL.state design and its limits | `.agents/specs/0001-skill-state-plan.md`, `extensions/skill-state/README.md` | Paper claims vs. what is reproduced; verification gates; honesty notes. |
| Change the state-run loop, retry, or telemetry | `extensions/skill-state/runner.ts` | Algorithm 1: render → complete → parse/validate → merge → execute; rollback-retry ≤ 2; per-step telemetry. |
| Change the state schema or merge bounds | `extensions/skill-state/schemas.ts`, `extensions/skill-state/state.ts` | TypeBox schemas with `additionalProperties: false`; `⊕` merge with null-delete, list replacement, 6 KB cap. |
| Change the action vocabulary or observation caps | `extensions/skill-state/executor.ts`, `extensions/skill-state/prompt.ts` | Repo-local actions, 200 lines / 8 KB observations; prompt text mirrors paper Appendix A.4. |
| Change the built-in SE skill or `--skill` loading | `extensions/skill-state/workflow.ts` | Spec ≤ 4 KB, used verbatim as `{spec}`. |

## CODE MAP
The package has 16 TypeScript source files and no tests. Reference counts below are structural indicators from the source layout rather than a generated call graph.

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| default | extension factory | `extensions/*/index.ts` | Registers each plugin's tools and event handlers. |
| `LspClient` | class | `extensions/lsp/client.ts:57` | Owns one language-server child process and JSON-RPC state. |
| `loadConfig` | function | `extensions/lsp/servers.ts:197` | Merges built-ins, user config, and trusted project config. |
| `findRoot` | function | `extensions/lsp/servers.ts:105` | Finds the nearest configured workspace marker without leaving the project root. |
| `clientsFor` | function | `extensions/lsp/index.ts:100` | Lazily selects or starts clients per `(server, root)` pair. |
| `runCodegraph` | function | `extensions/codegraph/index.ts:94` | Executes the external CodeGraph CLI and normalizes output/errors. |
| `callContext7` | function | `extensions/context7/index.ts:31` | Performs Context7 HTTP requests with timeout and optional auth. |
| `callApi` | function | `extensions/hindsight/index.ts:67` | Calls Hindsight bank endpoints for recall and retention. |
| `callVelox` | function | `extensions/web-tools/index.ts:23` | Calls Velox search/fetch endpoints with timeout and optional auth. |
| `run` | function | `extensions/skill-state/runner.ts:79` | SKILL.state loop; takes an injected `complete` so it can be driven by a stub. |
| `execute` | function | `extensions/skill-state/executor.ts:162` | Executes one repo action; never throws, errors become observations. |
| `merge` | function | `extensions/skill-state/state.ts:80` | Atomic `Σ ⊕ ΔΣ` with bound checks and rollback. |
| `render` / `lastFencedJson` | functions | `extensions/skill-state/prompt.ts:32`, `:65` | Single-message prompt; parses the last fenced JSON block. |
| `validateStepResponse` | function | `extensions/skill-state/schemas.ts:93` | TypeBox validation returning error paths that name offending keys. |
| `loadSpec` | function | `extensions/skill-state/workflow.ts:35` | Built-in spec or `--skill` file, ≤ 4 KB. |

## CONVENTIONS
- Keep one directory per plugin under `extensions/`; use `index.ts` as the loader entry point and add a sibling README for a plugin contract.
- Keep the default export a pi extension factory. Register tools/events through the provided `ExtensionAPI`; do not introduce a separate application entry point.
- Runtime imports must resolve from pi's dependency tree (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai/compat`, `@earendil-works/pi-tui`, `typebox`) or Node built-ins. Plugins intentionally ship no `node_modules`.
- Sibling imports omit the `.ts` extension (`from "./client"`); `allowImportingTsExtensions` is not enabled.
- The installed `pi` binary may lag `node_modules` types (0.83.0 vs 0.84.2 at last check). Use APIs present in both; e.g. resolve auth with `ctx.modelRegistry.getApiKeyAndHeaders` and call `complete` from `@earendil-works/pi-ai/compat`, not `ctx.modelRegistry.complete`.
- Use strict TypeScript with ES2022, ESNext, bundler resolution, and no emitted files. Match the existing direct string-concatenation style and typed TypeBox schemas when editing adjacent code.
- External API clients use environment-selected base URLs, optional bearer tokens, `AbortSignal` cancellation/timeouts, and readable tool errors that preserve HTTP status in `details.status` where applicable.
- Keep tool output model-ready: concise text plus small structured `details`; cap large external responses before returning them.

## ANTI-PATTERNS (THIS PROJECT)
- Do not add a build step: pi loads TypeScript directly through jiti; `bun run check` is typechecking only.
- Do not add per-plugin package manifests or dependencies unless the pi package model changes deliberately.
- Do not make CodeGraph initialize, index, or sync a project. It only shells out to an already available CLI/index and must fall back normally when CodeGraph is unavailable.
- Do not auto-install external binaries or restart failed language servers; LSP server availability is environment-owned and failures remain bounded to the session.
- Do not surface optional memory-ingestion failures as session errors; Hindsight retention is fire-and-forget.
- Do not expose secrets in tool output or commit API tokens/configuration.

## UNIQUE STYLES
- CodeGraph tools register only at `session_start` when both a resolvable CLI and an ancestor `.codegraph/` index exist; default tools are `explore,node`, with others opt-in through `CODEGRAPH_TOOLS`.
- Hindsight derives a bank per git project, skips extension inputs/slash commands/trivial prompts, and stores only user prompts plus the final assistant response.
- LSP starts one stdio client per `(server, root)` lazily on first matching file touch; automatic edit/write feedback reports only severity-1 diagnostics, capped at 20 per file.
- Web-tools and Context7 are thin HTTP adapters. Their README files are the source of truth for endpoint contracts and exposed parameters.
- TTS and STT are user-invoked only (`/speak` + `ctrl+alt+s`, `/dictate` + `ctrl+alt+d`) and expose no model-facing tool.
- Skill-state runs its own model loop outside the Pi conversation: telemetry goes to `appendEntry` custom entries (`skill-state-step`, `skill-state-run`, never in LLM context) and one ≤ 1 KB `skill-state-result` message is queued with `deliverAs: "nextTurn"`. One run at a time; `/state-cancel` and `session_shutdown` abort it. Model calls send no `reasoning` option on purpose, and no `temperature` unless `SKILL_STATE_TEMPERATURE` is set: some Velox upstreams (e.g. `gandalf`) reject the parameter with HTTP 400. `search_files` uses `git grep --untracked` so gitignored logs/build output never reach the model; `grep -r` only outside a git work tree.

## COMMANDS
```bash
bun install
bun run check
```

## NOTES
- There is no test suite, CI workflow, formatter, or linter configuration in the repository; do not claim broader validation than `bun run check`. Behavioural checks for skill-state were ad-hoc `bun` scripts in a scratch directory, not committed.
- To exercise an extension without the TUI: `pi --no-session -ne -nc -ns -np -e extensions/<plugin>/index.ts --mode json -p "/command args"`. Extension slash commands are dispatched in print mode, but `ui.notify` output is not rendered there; read `entry_appended` events instead.
- `bun.lock` is intentionally ignored by the current repository configuration; preserve that policy unless explicitly changing dependency management.
- `.omc/` and `.omo/` are ignored agent state. `.agents/plans/` is tracked documentation. `.codegraph` may be a local index link and is excluded by the repository's local git info exclude.
