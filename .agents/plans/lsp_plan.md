# Implementation Plan: `lsp` extension (LSP diagnostics + code intelligence)

## Goal

Add a new pi extension at `extensions/lsp/` that integrates Language Server
Protocol servers into the agent, modeled on opencode's LSP layer
(`packages/opencode/src/lsp/` in `anomalyco/opencode`):

1. **Automatic diagnostics** — after every `edit`/`write` tool call, sync the
   file to the matching LSP server(s) and append compiler/linter *errors* to
   the tool result the model sees.
2. **An `lsp` tool** — the model can call hover, go-to-definition, references,
   document/workspace symbols, and on-demand diagnostics.
3. **User configuration** — the user declares which LSP servers exist, the
   bin/command to spawn each one, and which file extensions each server
   handles — same shape as opencode's `lsp` config block.

**Style anchor:** `extensions/hindsight/index.ts` — default-export factory,
typebox params, `type: "text" as const` content blocks, errors returned as
readable tool errors, never crashes. This extension is larger than hindsight,
so it splits into a few modules inside `extensions/lsp/` (pi only requires
`index.ts` as the entry point; sibling files are imported relatively).

## How opencode does it (reference, verified against source)

- Config `lsp: boolean | Record<id, entry>`; entry =
  `{ command: string[], extensions?: string[], env?, initialization?, disabled? }`.
  Custom (non-builtin) ids **must** declare `extensions`. Built-ins are merged
  under user overrides; `disabled: true` removes one.
- 38 built-in servers (`lsp/server.ts`), each an `Info` with `extensions`,
  a `root(file)` marker-walk function, and a `spawn` (some auto-download).
- **Lazy lifecycle**: nothing starts at boot; first touch of a matching file
  spawns one client per `(server, root)` key over **stdio**. Failed spawns go
  into a `broken` set and are never retried. No crash-restart. Shutdown just
  tears down the pipe and kills the process.
- **Client** (`lsp/client.ts`): `vscode-jsonrpc` for framing; hand-rolled
  protocol on top. `initialize` with minimal capabilities →
  `initialized` → optional `didChangeConfiguration`. File sync reads from
  disk (`didOpen` v0, then `didChange` v++, full text). Diagnostics via push
  (`publishDiagnostics`) + pull (`textDocument/diagnostic`), merged;
  `waitForDiagnostics` races a fresh push (150 ms settle) against pulls,
  timeout 5 s.
- **Agent integration**: edit/write tools call `touchFile` +
  `waitForDiagnostics`, then append
  `LSP errors detected in this file, please fix:\n<diagnostics file="...">…`
  — **errors only** (severity 1), max 20 per file. Plus one `lsp` tool with an
  `operation` enum (hover, goToDefinition, findReferences, symbols, call
  hierarchy...) returning raw JSON. All LSP calls are `.catch`-swallowed so
  LSP can never break the agent.

## Decisions (tradeoffs surfaced)

1. **Hand-rolled JSON-RPC framing, no `vscode-jsonrpc`.** Repo convention:
   runtime imports must resolve from pi's own dependency tree or node
   builtins, and pi ships no JSON-RPC lib (verified its `dependencies`).
   Content-Length framing over child stdio is ~100 lines with
   `node:child_process` + a stateful buffer parser. Alternative: declare
   `vscode-jsonrpc` in this package's `dependencies` (pi packages do install
   production deps) — rejected to keep the "no node_modules" convention; say
   so if you'd rather take the dependency.
2. **Push diagnostics only (no LSP 3.17 pull).** Every server in the default
   catalog below publishes diagnostics. Pull support (`textDocument/diagnostic`,
   dynamic registration) is what makes opencode's client 650 lines; skipping
   it roughly halves ours. Add later if a pull-only server shows up.
3. **No auto-download of servers.** opencode npm-installs/downloads missing
   servers. Here a server whose `command[0]` is not on `PATH` is silently
   skipped (surfaced in `/lsp` status). Binaries come from the environment
   (nix), which fits your setup.
4. **Small built-in catalog, config-first.** Ship defaults for typescript,
   gopls, rust-analyzer, pyright, ruby-lsp, nixd (data-driven: command +
   extensions + root markers). Everything else is user config. Not porting
   opencode's 38 servers or the deno/tsserver exclusion dance.
5. **One `lsp` tool with an `operation` parameter** (like opencode), not one
   tool per operation — keeps the tool list small.

## Configuration

JSON file, merged in order (later wins per server id):
**built-in defaults** ← **global** `~/.pi/agent/lsp.json` ← **project**
`<cwd>/<CONFIG_DIR_NAME>/lsp.json` (only when `ctx.isProjectTrusted()`;
import `CONFIG_DIR_NAME` from the pi package instead of hardcoding `.pi`).

Schema (opencode-compatible field names):

```jsonc
{
  // built-in override: fields are optional, "disabled" removes it
  "typescript": { "disabled": true },
  "rust": { "env": { "RUST_LOG": "warn" } },

  // custom server: command + extensions required
  "svelte": {
    "command": ["svelteserver", "--stdio"],
    "extensions": [".svelte"],
    "rootMarkers": ["package.json"],
    "initialization": {},
    "env": {}
  }
}
```

Per-server resolved shape: `{ id, command: string[], extensions: string[],
rootMarkers: string[], env?, initialization?, disabled? }`. A custom entry
without `extensions` or `command` is a config error reported once via
`ctx.ui.notify(..., "warning")` and skipped. Env var `PI_LSP_DISABLED=1`
turns the whole extension off (cheap kill switch, hindsight-style env
config).

Built-in defaults:

| id | command | extensions | rootMarkers |
| --- | --- | --- | --- |
| typescript | `typescript-language-server --stdio` | .ts .tsx .js .jsx .mjs .cjs .mts .cts | tsconfig.json, package.json |
| gopls | `gopls` | .go | go.work, go.mod |
| rust | `rust-analyzer` | .rs | Cargo.toml |
| pyright | `pyright-langserver --stdio` | .py .pyi | pyproject.toml, setup.py, requirements.txt |
| ruby | `ruby-lsp` | .rb .rake .gemspec | Gemfile |
| nix | `nixd` | .nix | flake.nix, default.nix |

Plus a small `ext → languageId` map for `didOpen` (`.ts → typescript`,
`.py → python`, ...; fallback: extension without the dot).

## Architecture

```
extensions/lsp/
  index.ts        # entry: config load, registry, tool_result hook, lsp tool, /lsp command
  client.ts       # LspClient: framing, initialize, didOpen/didChange, diagnostics store, request()
  servers.ts      # built-in catalog, languageId map, root detection (marker walk-up)
  README.md
```

**Registry (in `index.ts`):** `Map<root + "\0" + serverId, LspClient>`,
`Map<key, Promise<LspClient>>` to dedupe concurrent spawns, `Set<key>` of
broken keys (spawn/initialize failed once → never retried this session).
`clientsFor(absPath, ctx)`: match extension against enabled servers → resolve
root per server (walk up from `dirname(file)` to `ctx.cwd` looking for
`rootMarkers`, default `ctx.cwd`) → spawn missing clients (skip if
`command[0]` not found on PATH). Multiple servers may match one file
(opencode behavior) — query all, merge results.

**LspClient (`client.ts`):**
- `spawn(command, { cwd: root, env: {...process.env, ...cfg.env} })`, stdio
  piped, stderr drained.
- Framing: buffer stdout; parse `Content-Length: N\r\n\r\n<json>` frames;
  write requests/notifications with the same header. Numeric id counter +
  pending-promise map. Respond `null` to server→client requests
  (`workspace/configuration` answered from `initialization` options;
  `client/registerCapability` acked and ignored).
- `initialize(rootUri, initializationOptions)` with minimal capabilities
  (textDocument.synchronization + publishDiagnostics), then `initialized`.
  Timeout 15 s → throw → caller marks broken.
- `touchFile(absPath)`: read file from disk; first time → `didOpen`
  (version 0, languageId); after → `didChange` (version++, full-text change).
- Diagnostics: store latest `publishDiagnostics` per URI.
  `waitForDiagnostics(uri, timeoutMs = 3000)`: resolve on the first publish
  for that URI arriving after the last `touchFile`, then let pushes settle
  150 ms (tsserver pushes multiple times); resolve empty on timeout.
- `dispose()`: kill the child process (opencode doesn't bother with the LSP
  shutdown/exit handshake either), reject pending requests.
- Every public method catches and returns empty/null — LSP must never
  surface as a session error.

## Steps

### 1. `extensions/lsp/servers.ts` + config loading → verify: `bun run check`

Built-in catalog table above as data, `LANGUAGE_IDS` map, `findRoot(file,
cwd, markers)` walk-up, `loadConfig(ctx)` (defaults ← global ← trusted
project, validation, `PI_LSP_DISABLED`). Pure functions; no processes yet.

### 2. `extensions/lsp/client.ts` → verify: standalone smoke script

Implement `LspClient` per the architecture above. Verify outside pi with a
throwaway script (scratchpad, not committed):
`typescript-language-server --stdio` against this repo → initialize succeeds,
`touchFile` on a file with a deliberate type error → `waitForDiagnostics`
returns the error with correct line numbers.

### 3. `extensions/lsp/index.ts` — registry + hooks + tool → verify: `bun run check`

- **Registry** as described (lazy spawn, broken set, spawn dedupe).
- **`pi.on("tool_result", ...)`**: only `isEditToolResult(event)` /
  `isWriteToolResult(event)`, skip when `event.isError`. Resolve
  `event.input.path` against `ctx.cwd`; `clientsFor` → for each client
  `touchFile` + `waitForDiagnostics`; merge, keep **severity 1 (Error) only**,
  cap 20 with `... and N more`. If any: return
  `{ content: [...event.content, { type: "text", text }] }` where `text` is
  opencode's format —
  `LSP errors detected in this file, please fix:\n<diagnostics file="src/foo.ts">\nERROR [12:5] Type 'string' is not assignable...\n</diagnostics>`
  (1-based line:col). No errors → return nothing (result untouched).
- **`lsp` tool** (`pi.registerTool`): typebox params
  `operation: "hover" | "goToDefinition" | "findReferences" | "documentSymbol" | "workspaceSymbol" | "diagnostics"`,
  `filePath` (required), `line`/`column` optional 1-based integers (required
  by the positional ops; validated in execute), `query` optional (for
  workspaceSymbol). Execute: no client for extension → readable tool error
  ("No LSP server configured for .foo files"); else `touchFile` then send the
  request (0-based conversion), return `JSON.stringify(result, null, 2)`;
  `diagnostics` returns the stored diagnostics for the file (all severities).
  `promptSnippet`/`promptGuidelines`: one line each — use `lsp` to look up
  definitions/references/types instead of grepping when a server is available.
- **`pi.on("session_shutdown")`**: dispose all clients.
- **`/lsp` status command** (`pi.registerCommand`): list configured servers →
  running (root, pid) / idle / not-on-PATH / broken.

### 4. `extensions/lsp/README.md` → verify: covers tool, hook, config

Hindsight README shape: what it does (auto-diagnostics + tool), config file
locations and schema, built-in catalog table, `PI_LSP_DISABLED`, limitations
(push-only diagnostics, no auto-install, no crash-restart).

### 5. Root `README.md` → verify: table row present, wishlist updated

Add `lsp` row to the Plugins table; remove the LSP bullet from "New Plugins".

### 6. Verification → all must pass before done

1. `bun run check` typechecks clean.
2. Client smoke script (step 2) against `typescript-language-server` and
   `nixd`.
3. In-agent, via a `.pi/extensions/` re-export in a TS project:
   - Ask pi to introduce a type error via `edit` → tool result shows the
     `<diagnostics>` block; ask it to fix → next edit result clean.
   - Ask "where is X defined / who references X" → `lsp` tool round-trips.
   - `/lsp` shows the running server and root.
   - Unconfigured filetype (e.g. `.md`) edits are untouched, no latency.
   - Server not on PATH → skipped silently, `/lsp` says so, nothing crashes.

## Out of scope (intentionally)

- Auto-installing/downloading language servers (opencode does; we don't).
- Pull diagnostics (`textDocument/diagnostic`), dynamic capability
  registration, call hierarchy, code actions, formatting, rename.
- Crash-restart of dead servers (matching opencode: broken = skipped).
- Deno-vs-tsserver root exclusion logic and per-server special cases
  (venv detection, tsserver path resolution) — `initialization` config
  covers these manually when needed.
