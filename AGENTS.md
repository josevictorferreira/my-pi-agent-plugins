# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-24
**Commit:** 161d7a3
**Branch:** main

## OVERVIEW
Single Bun/TypeScript pi package containing five independently loaded extensions. Pi loads `extensions/*/index.ts` through jiti; there is no build step and the repository has one root package boundary.

## STRUCTURE
```text
.
├── extensions/              # loadable pi extensions
│   ├── codegraph/            # CodeGraph CLI-backed semantic exploration
│   ├── context7/             # Context7 documentation API client
│   ├── hindsight/            # Hindsight memory API and automatic retention
│   ├── lsp/                  # language-server client, configuration, and pi hooks
│   └── web-tools/            # Velox web search and URL extraction
├── .agents/plans/            # tracked design plans
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

## CODE MAP
The package has 7 TypeScript source files and no tests. LSP analysis reports no diagnostics. Reference counts below are structural indicators from the source layout rather than a generated call graph.

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

## CONVENTIONS
- Keep one directory per plugin under `extensions/`; use `index.ts` as the loader entry point and add a sibling README for a plugin contract.
- Keep the default export a pi extension factory. Register tools/events through the provided `ExtensionAPI`; do not introduce a separate application entry point.
- Runtime imports must resolve from pi's dependency tree (`@earendil-works/pi-coding-agent`, `typebox`) or Node built-ins. Plugins intentionally ship no `node_modules`.
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

## COMMANDS
```bash
bun install
bun run check
```

## NOTES
- There is no test suite, CI workflow, formatter, or linter configuration in the repository; do not claim broader validation than `bun run check`.
- `bun.lock` is intentionally ignored by the current repository configuration; preserve that policy unless explicitly changing dependency management.
- `.omc/` and `.omo/` are ignored agent state. `.agents/plans/` is tracked documentation. `.codegraph` may be a local index link and is excluded by the repository's local git info exclude.
