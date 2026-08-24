# LSP EXTENSION KNOWLEDGE BASE

## OVERVIEW
Language-server integration for pi: lazy stdio clients, JSON-RPC framing, server catalog/configuration, edit/write diagnostics, and the `lsp` query tool.

## STRUCTURE
| File | Responsibility |
| --- | --- |
| `index.ts` | Extension factory, client lifecycle, automatic diagnostics, `lsp` tool, `/lsp` status, shutdown cleanup. |
| `client.ts` | `LspClient`, Content-Length framing, request/notification handling, file sync, pushed diagnostics, process disposal. |
| `servers.ts` | Built-in catalog, `languageIdFor`, env disable switch, root discovery, strict JSON config loading/merging. |
| `README.md` | Supported operations, lifecycle, configuration schema, limitations. |

## WHERE TO LOOK
- Change client startup or `(server, root)` reuse in `index.ts` (`startClient`, `clientsFor`).
- Change automatic edit/write feedback in the `tool_result` handler in `index.ts`.
- Add or change LSP operations in the `lsp` tool switch in `index.ts`; positional inputs are 1-based at the tool boundary and converted to 0-based LSP positions.
- Change wire protocol or server requests in `client.ts`; preserve stdio framing and bounded request/diagnostic waits.
- Add built-in servers or change trusted/user config merging in `servers.ts` and update `README.md`.

## CONVENTIONS
- Servers start only when a matching file is first touched; maintain one client per `(server, root)` key.
- Missing binaries, failed initialization, and dead processes are session-bounded states. They are reported through `/lsp` or readable tool errors.
- Automatic feedback reports severity-1 diagnostics only, capped at 20 per file. The `diagnostics` operation returns all severities.
- Configuration is strict JSON and merges built-ins, user config, then trusted project config; later entries win per server id and `disabled: true` removes an entry.
- Keep client dependencies to Node built-ins and local modules; the package intentionally does not add a JSON-RPC dependency.

## ANTI-PATTERNS
- Do not auto-install language servers.
- Do not restart a server after failed startup, initialization, or process exit within the same session.
- Do not let optional diagnostics failures fail the edit/write operation or session.
- Do not implement pull diagnostics or dynamic capability registration without updating the documented protocol boundary.
- Do not move project-root discovery above the trusted `cwd` boundary.

## VALIDATION
```bash
bun run check
```

There is no LSP-specific test suite in this repository; keep behavior changes aligned with the contract in `README.md` and verify the strict typecheck.
