# codegraph

Semantic code search and exploration for pi, backed by
[CodeGraph](https://github.com/colbymchenry/codegraph).

This is a thin wrapper over the **`codegraph` CLI** — it installs nothing and
runs no daemon of its own. Each tool call shells out to a
subcommand and relays its output.

CodeGraph ships an MCP server, but [pi has no MCP by
design](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), and the CLI
is at full parity with the MCP tool surface (upstream documents `codegraph
explore` as "same output as the `codegraph_explore` MCP tool", and likewise for
the rest). So there is no JSON-RPC bridge here — just `execFile`.

## Prerequisites

1. The `codegraph` CLI on `PATH` (or see `CODEGRAPH_BIN` below).
2. An index for the project — built automatically for git repos (below), or
   `codegraph init` in the project root.

**The tools register only when both are true** — a resolvable binary, and a
`.codegraph/` directory at the cwd or any ancestor. Otherwise pi starts with no
`codegraph_*` tools at all, rather than tools that can only answer "not
indexed". Resolution happens on `session_start`, so `/resume`-ing into an
indexed project picks them up without a restart.

### Auto-init

When a session starts inside a git repo with no index, the extension runs
`codegraph init <git root>` in the background and registers the tools once it
finishes (a `ui.notify` says when). The session is never blocked: the first
session in a large repo just runs without codegraph until the index is ready.

- `.codegraph` is appended to the repo's `.git/info/exclude`, because the
  index's own `.gitignore` un-ignores itself and would otherwise show up in
  `git status` as untracked.
- `init` runs detached, so quitting pi mid-index doesn't abort it; the next
  session finds the finished index.
- It never indexes outside a git work tree, or a repo rooted at `$HOME`.
- `CODEGRAPH_AUTO_INIT=0` turns it off. `codegraph uninit` removes an index.

The *model* still never runs `init`, `index` or `sync` — upstream tells agents
"indexing is the user's decision, do not run it yourself", and auto-init is that
decision made once, here. When a call does hit an unindexed project (via
`project_path`), that guidance is relayed as a normal result — not a tool error
— so the model falls back to grep/read instead of retrying.

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

## Search nudge

Some models ignore the prompt guidelines and explore with `grep` anyway. So
while `codegraph_explore` is active and no `codegraph_*` tool has run yet in the
session, the first bash command that *starts* with `grep`, `egrep`, `rg`, `ag`,
`ack` or `git grep` is blocked once, with a message pointing at
`codegraph_explore`. It fires at most once per session: running the same command
again goes through, so a literal text search is never blocked twice. Searches
piped out of another command (`kubectl get pods | grep api`) are not matched.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CODEGRAPH_BIN` | unset | Absolute path to the binary; skipped if the file does not exist |
| `CODEGRAPH_TOOLS` | `explore,node` | Comma-separated tools to register (`explore`, `node`, `query`, `callers`, `callees`, `impact`, `files`, `status`) |
| `CODEGRAPH_TIMEOUT_MS` | `120000` | Per-call child-process timeout |
| `CODEGRAPH_AUTO_INIT` | unset | `0` disables indexing unindexed git repos at session start |

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
