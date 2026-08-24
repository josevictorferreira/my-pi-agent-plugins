# lsp

Language Server Protocol integration for pi: compiler errors land in the tool
result right after an `edit`/`write`, and an `lsp` tool lets the model ask a
language server about the code instead of grepping for it.

Modeled on [opencode](https://github.com/anomalyco/opencode)'s `lsp/` layer,
minus the parts that need a package manager (see [Limitations](#limitations)).

## Automatic diagnostics

After every successful `edit` or `write`, the file is synced to every language
server that claims its extension and the extension waits (up to 3s) for a fresh
`publishDiagnostics`. Only **errors** (severity 1) are reported, capped at 20
per file, appended to the tool result the model sees:

```
LSP errors detected in this file, please fix:
<diagnostics file="src/main.ts">
ERROR [3:14] Type 'string' is not assignable to type 'number'. (typescript)
</diagnostics>
```

Positions are 1-based, matching what `read` shows. A clean file adds nothing to
the result. Files with no matching server (say `.md`) return immediately and
never spawn anything.

## `lsp` tool

| Parameter | Type | Notes |
| --- | --- | --- |
| `operation` | `hover` \| `goToDefinition` \| `findReferences` \| `documentSymbol` \| `workspaceSymbol` \| `diagnostics` | required |
| `filePath` | string, required | absolute or relative to the project root; also selects which server answers |
| `line`, `column` | integer ≥ 1 | required by `hover`, `goToDefinition`, `findReferences` |
| `query` | string | required by `workspaceSymbol` |

The raw LSP response is returned as pretty-printed JSON (a `{ server, result }`
array when more than one server matches the file). `diagnostics` returns the
server's current diagnostics for the file at every severity, not just errors.

Failures are readable tool errors, never session errors: an unconfigured
extension reports `No LSP server configured for .foo files`, a configured
server that is not on PATH reports that it is not running and points at `/lsp`.

## `/lsp`

Lists every configured server and its state: `running` (with root and pid),
`idle` (never needed yet), `not on PATH`, or `failed to start`.

## Lifecycle

Nothing starts at boot. The first touch of a matching file spawns one process
per `(server, root)` pair over stdio, where the root is the nearest ancestor
directory of the file holding one of the server's `rootMarkers` (searching no
higher than the project root, which is the fallback). A server that fails to
spawn or initialize is marked broken and never retried for the session; a
server that dies is not restarted. All processes are killed on
`session_shutdown`.

## Configuration

JSON, merged in order — later files win per server id:

1. built-in defaults (below)
2. `~/.pi/agent/lsp.json`
3. `<project>/.pi/lsp.json`, only when the project is trusted

```json
{
  "typescript": { "disabled": true },
  "rust": { "env": { "RUST_LOG": "warn" } },
  "svelte": {
    "command": ["svelteserver", "--stdio"],
    "extensions": [".svelte"],
    "rootMarkers": ["package.json"],
    "initialization": {}
  }
}
```

| Field | Notes |
| --- | --- |
| `command` | argv of the server, spoken to over stdio. Required for a new id |
| `extensions` | file extensions the server handles; a leading dot is optional. Required for a new id |
| `rootMarkers` | filenames that mark a workspace root; default: none, so the project root is used |
| `env` | extra environment variables for the process |
| `initialization` | `initializationOptions`, also what `workspace/configuration` requests are answered with |
| `disabled` | `true` removes the server entirely |

Overriding a built-in only needs the fields being changed. Strict JSON — no
comments. Config problems are reported once as a warning notification and the
offending entry is skipped.

Built-in defaults:

| id | command | extensions | rootMarkers |
| --- | --- | --- | --- |
| typescript | `typescript-language-server --stdio` | .ts .tsx .js .jsx .mjs .cjs .mts .cts | tsconfig.json, package.json |
| gopls | `gopls` | .go | go.work, go.mod |
| rust | `rust-analyzer` | .rs | Cargo.toml |
| pyright | `pyright-langserver --stdio` | .py .pyi | pyproject.toml, setup.py, requirements.txt |
| ruby | `ruby-lsp` | .rb .rake .gemspec | Gemfile |
| nix | `nixd` | .nix | flake.nix, default.nix |

| Env var | Purpose |
| --- | --- |
| `PI_LSP_DISABLED` | any value other than empty/`0`/`false` turns the whole extension off — no hooks, no tool, no command |

## Limitations

- **No auto-install.** Servers come from the environment; one whose binary is
  not on `PATH` is skipped silently and shown as such in `/lsp`.
- **Push diagnostics only.** `textDocument/diagnostic` (LSP 3.17 pull) and
  dynamic capability registration are not implemented. Every server in the
  built-in catalog publishes.
- **No restart.** A server that crashes stays down until the session restarts.
- **Errors only in tool results.** Warnings and hints are reachable through the
  `lsp` tool's `diagnostics` operation.
- Call hierarchy, code actions, formatting and rename are not exposed.
