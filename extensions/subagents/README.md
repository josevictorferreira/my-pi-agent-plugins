# subagents

Delegate work from a Pi agent to **subagents**: separate, fully interactive `pi` processes, each in its own tmux pane, in the same working directory, with a type-specific system prompt, model, tool allowlist and skill set. The user can watch and type into every pane. Each time a subagent finishes a turn, the launching agent is interrupted with the result (Pi `steer` delivery), decides what to do, and continues. Subagents can launch subagents of their own; every descendant of one root Pi session lands in the same tmux session.

Design and decisions: `.agents/specs/0003-subagents/plan.md`.

## Tools (model-facing)

| Tool | Parameters | Does |
| --- | --- | --- |
| `subagent_launch` | `type`, `title` (≤ 80 chars), `prompt` | Starts a pane running `pi --session-id <taskId> … "<prompt>"` and returns immediately with the task id. |
| `subagent_check` | `taskId?` (id or unique prefix, ≥ 4 chars) | One line per own task, or the detail of one: status, model, turns, last result (≤ 16 KB), last 10 tool calls read from the child's session file. |
| `subagent_send` | `taskId`, `message` | Queues a follow-up user message for an open subagent; its reply arrives like any other result. |
| `subagent_close` | `taskId` | Closes the subagent and everything it launched: kills the pane, marks the task `closed`. |

A session only sees the tasks it launched itself (`parentSessionId` equals its own session id).

### Hand-back message

Every settled turn of a child produces one `subagent-result` custom message in the launcher, delivered with `deliverAs: "steer", triggerTurn: true`: after the launcher's current tool calls and before its next LLM call, or immediately if it is idle. Format:

```
subagent explorer "lsp hooks" (3f9c2a1b) finished turn 1 [stopReason: error] [fell back to velox/glm-5-3]

<final assistant text of the child, capped at 8 KB>

The subagent is still open: reply with subagent_send to continue it, or subagent_close when done.
```

Turns started by the user typing into the pane are handed back too. A child whose pane disappears without writing a result is reported once as `exited`.

## Command

`/subagents [--all]` prints the launch tree of the current root (`<id8> <type> "<title>" <status> turns=<n> <model>`) and the `tmux attach -t pi-<id8>` hint. `--all` lists every root recorded for this directory, newest first (read-only history).

## Types

| Type | Default tools | Intent |
| --- | --- | --- |
| `explorer` | `read, grep, find, ls, codegraph_explore, codegraph_node, lsp` | Local recon: files with line ranges, entry points, data flow, risks, as a handoff brief. |
| `researcher` | `read, web_search, web_fetch, context7_resolve_library_id, context7_query_docs` | Research brief with conclusion, findings and sources. |
| `worker` | all | Implementation; reports changed files, verification commands, leftovers. |
| `oracle` | same as explorer | Second opinion: decision restated, risks, alternatives, one recommendation. |

Unknown names in a tool allowlist are ignored by Pi, so a type may list tools from sibling extensions that are not installed. A type without a `model` inherits the **launcher's current model**.

### Overrides: `~/.pi/agent/subagents/<type>.md`

```markdown
---
model: velox/glm-5-3
fallbackModel: google/gemini-2.5-flash-lite
tools: [read, grep, find, ls, bash]
skills: brainstorming, ./.pi/skills/repo-conventions
---
Prefer `rg` over `grep`. Always finish with a "Next steps" section.
```

- Frontmatter keys `model`, `fallbackModel`, `tools`, `skills` **replace** the built-in value (lists may be `a, b` or `[a, b]`).
- The body is **appended** to the built-in prompt.
- A file whose name is not a built-in type defines a new type; it needs `description` in the frontmatter and a body.
- `skills` entries are looked up as `~/.pi/agent/skills/<name>` then `<cwd>/.pi/skills/<name>`; an entry containing `/` is a path (relative to the cwd). The child is started with `--no-skills` plus one `--skill` per entry. An entry that resolves to nothing fails the launch.
- Files are read on every launch; edits apply without restarting Pi.

The child's system prompt is a fixed base ("you are a subagent of type X launched by another agent; your final message each turn is delivered verbatim to it…") + type prompt + override body, passed through `--append-system-prompt <file>`.

## Fallback model

When a child's settled turn ends with `stopReason: "error"` and the type has `fallbackModel`, the child switches itself once (`pi.setModel`), records `fellBack`, and sends itself "the model was switched; continue the task". The pane and partial work are kept. A second error is handed back to the parent like any result.

## Files and environment

State lives outside the repository, keyed like skill-state's checkpoints:

```
~/.pi/agent/subagents/<cwd slug>/<rootSessionId>/tasks/
  <taskId>.json        status, parent, type, title, pane, model, turns…
  <taskId>.result.md   last final assistant text (overwritten each turn)
  <taskId>.inbox.jsonl follow-ups from subagent_send
  <taskId>.system.md   assembled system prompt
```

One file per task: the launcher writes it once, then only the child, then only the closer, so no locking is needed. Writes are tmp-then-rename.

Panes receive three variables: `PI_SUBAGENT_TASK` (task id = the child's session id), `PI_SUBAGENT_ROOT` (root session id, inherited unchanged by grandchildren), `PI_SUBAGENT_PARENT` (launching session id). `PI_SUBAGENT_TASK` switches the extension into the child role in that process.

When this extension is loaded from a repo checkout with `-e` (as opposed to `~/.pi/agent/extensions` or `<cwd>/.pi/extensions`), the launcher adds `-e <this index.ts>` to the child command so the child role is present there too.

## tmux

- Session `pi-<first 8 chars of the root session id>`, window `subagents`, one pane per task, `tiled` layout. The first subagent *is* the first pane (no idle shell). Attach with `tmux attach -t pi-<id8>`; `/subagents` prints the command.
- More than about four concurrent subagents gets cramped. `tmux break-pane -d` moves a pane to its own window; the pane id is kept, so it is still tracked.
- Panes inherit the **tmux server's** environment plus the three variables above, not the launcher's. If the server was started from a shell without your provider credentials, children fail to authenticate; start tmux from a configured shell or use `tmux set-environment -g`.
- Quitting a Pi session closes every subagent it launched (recursively); the root also kills the tmux session once it has no panes. Task files are kept as history.

## Limits and failure policy

- No `tmux` or `pi` on `PATH`, unknown type, unresolvable skill, unknown or foreign task id: readable tool error, nothing launched.
- tmux failures (bad server, no permission) are returned with tmux's stderr; the pre-written record is removed.
- Caps: result in the hand-back 8 KB, in `subagent_check` 16 KB; tool-call tail 10 entries × 80 chars.
- No dependency scheduling, no result piping between tasks, no per-launch overrides, no Windows/non-tmux backend.
- The launcher polls task files and `tmux list-panes` every 1.5 s while it has open tasks; the child polls its inbox at the same rate.

## Verification

There is no test suite. Checks that were run (scratch scripts, not committed):

1. `state.ts`/`types.ts`: tree and prefix resolution, inbox offsets, result capping, override merge (`tools` replaced, body appended), user-defined type, skill resolution and its failure.
2. `tmux.ts` against a private server (`tmux -L subagents-test`): session created with the first pane, per-pane env and cwd visible inside the pane, listing, kill, kill-when-empty; `shellQuote` round-trips quotes, `$`, backticks and newlines through `sh`, `bash` and `zsh`.
3. Child role in print mode (`PI_SUBAGENT_TASK=… pi --session-id … -p "Reply with the single word pong"`): record goes `running → idle (turns 1) → exited`, `sessionFile` set, `result.md` holds the reply; with an invalid primary key and `fallbackModel` set, the child switched models and still answered.
4. End to end with an interactive parent in tmux: see the commit message of the launcher commit for the scenario and observed screen output.
