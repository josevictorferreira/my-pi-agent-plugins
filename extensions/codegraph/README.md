# codegraph

Semantic code search and exploration for pi, backed by
[CodeGraph](https://github.com/colbymchenry/codegraph).

This is a thin wrapper over the **`codegraph` CLI** — it installs nothing,
indexes nothing, and runs no daemon of its own. Each tool call shells out to a
subcommand and relays its output.

CodeGraph ships an MCP server, but [pi has no MCP by
design](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), and the CLI
is at full parity with the MCP tool surface (upstream documents `codegraph
explore` as "same output as the `codegraph_explore` MCP tool", and likewise for
the rest). So there is no JSON-RPC bridge here — just `execFile`.

## Prerequisites

1. The `codegraph` CLI on `PATH` (or see `CODEGRAPH_BIN` below).
2. An index for the project: `codegraph init` in the project root.

**The tools register only when both are true** — a resolvable binary, and a
`.codegraph/` directory at the cwd or any ancestor. Otherwise pi starts with no
`codegraph_*` tools at all, rather than tools that can only answer "not
indexed". Resolution happens on `session_start`, so `/resume`-ing into an
indexed project picks them up without a restart.

Initializing is deliberately left to you. Upstream's own message to agents on an
unindexed project reads:

> If you are an AI agent: continue with your usual tools; indexing is the user's
> decision, do not run it yourself.

So this extension never runs `init`, `index` or `sync`. When a call does hit an
unindexed project (via `project_path`), that guidance is relayed as a normal
result — not a tool error — so the model falls back to grep/read instead of
retrying.

## Tools

Two are registered by default. Upstream found that one strong tool steers agents
better than a menu of narrow ones, and unlists the rest in its own MCP server
for the same reason — everything they return already arrives inline on
`explore`.

- **`codegraph_explore`** — the primary tool. Answers "how does X work", "how
  does X reach Y", or "survey this area" in one call: the relevant symbols'
  verbatim line-numbered source grouped by file, the call paths between them,
  and a blast-radius summary of dependents (flagging symbols with no covering
  tests). Follows dynamic dispatch — callbacks, interface-to-implementation,
  framework re-render — that grep cannot.
  Queries can be a question, or a bag of symbol names spanning a flow
  (`"OrderController submit OrderService placeOrder"`); naming the class
  alongside an ambiguous method disambiguates it.
- **`codegraph_node`** — pinpoint read: one symbol's source plus its
  caller/callee trail, or a file with line numbers and its dependents.
  Container symbols (classes, interfaces, modules, enums) return a structural
  outline with a member list **by design** — for a container's body, call it on
  a specific member, or use `file` for file mode.

Six more ship but stay unregistered unless named in `CODEGRAPH_TOOLS`:
`query` (symbol search), `callers`, `callees`, `impact`, `files`, `status`.

```sh
CODEGRAPH_TOOLS=explore,node,callers,impact pi
```

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CODEGRAPH_BIN` | unset | Absolute path to the binary; skipped if the file does not exist |
| `CODEGRAPH_TOOLS` | `explore,node` | Comma-separated tools to register (`explore`, `node`, `query`, `callers`, `callees`, `impact`, `files`, `status`) |
| `CODEGRAPH_TIMEOUT_MS` | `120000` | Per-call child-process timeout |

Binary resolution: `CODEGRAPH_BIN` → `codegraph` on `PATH` →
`~/.omo/codegraph/bin/codegraph` (where
[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) provisions
it, so an existing OMO install works with no `PATH` changes).

Every tool takes an optional `project_path` to query a different indexed project
— a monorepo sub-service, or a second repo — without changing directory.

## Notes

- `codegraph` ignores `NO_COLOR`, so output from the six non-default tools is
  ANSI-stripped before it reaches the model. `explore` and `node` emit clean
  markdown and are relayed verbatim.
- Cancelling a tool call kills the child process; CodeGraph's own daemon
  (started and reaped by the CLI) is left alone.
