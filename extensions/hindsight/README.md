# hindsight

Long-term memory for pi, talking straight to a
[Hindsight](https://github.com/vectorize-io/hindsight) REST API (there is no
MCP server and no pi integration upstream — only claude-code/opencode plugins,
so the HTTP contract is reimplemented here).

## Two banks

- **Project bank** (`deriveBankId(ctx.cwd)`) — per git project (main-worktree
  basename; linked worktrees share their repo's bank; cwd basename outside
  git). Fed by auto-retention only.
- **User bank** (`HINDSIGHT_USER_BANK`, default `pi-agent-user`) — one shared
  across every project. Fed only explicitly: the `hindsight_remember` tool
  and the self-learn lesson extractor. On `session_start` (once per process)
  the extension PATCHes the user bank config with a `retain_mission` steering
  the extractor toward durable user facts (preferences, conventions, lessons)
  and away from project implementation details. Fire-and-forget.

User-bank items are tagged `kind:<preference|decision|lesson>` and
`project:<projectBankId>` so recall can show where a fact was learned.

## What gets stored (auto-retention)

Storage is deterministic, not model-discretion — auto-retention stays
project-only. Per agent run, exactly two kinds of content are ingested
(`POST /v1/default/banks/{bank}/memories`, `async: true` — synchronous
ingestion runs LLM extraction inline and blows past any sane tool timeout):

- **Your own prompts** — captured on the `input` event. Skipped: extension-injected
  inputs, slash commands, and prompts shorter than `MIN_PROMPT_CHARS` (12).
- **The final assistant response** — the last assistant message of the run,
  captured on `agent_end`. Intermediate turns, tool calls and tool results are
  never stored.

Items are truncated to `MAX_ITEM_CHARS` (8000) and sent as one fire-and-forget
POST per run; ingestion failures never surface as session errors.

## Tools

- `hindsight_recall` — search long-term memory
  (`POST /v1/default/banks/{bank}/memories/recall`, budget `mid`). Searches
  both banks in parallel by default (`scope: both|project|user`), merges and
  dedupes results sorted by final score, each line prefixed `[user]` or
  `[project]`. If one bank fails the other is still returned with a note.
- `hindsight_remember` — explicitly store one durable fact
  (`scope: user|project`, `kind: preference|decision|lesson`, optional `why`).
  Use `scope: user` for preferences/conventions that are not repo-specific,
  `scope: project` for decisions about this codebase.

`reflect` is deliberately not exposed: the upstream endpoint never returns on
the target deployment (still timing out after 45s as of 2026-08-21). Re-add it
if that deployment's reflection backend starts working.

## Self-learn autopilot

When a run shows friction, the extension distills a lesson using the session's
active model and stores it:

| Signal | Rule |
| --- | --- |
| User correction | prompt (lowercased) starts with `no`, `no,`, `nope`, `wrong`, `not that`, `actually`, `i said`, `i told you`, `instead`, `don't`, `stop` — flags the previous run |
| Tool errors | ≥ 2 results with `isError` in one run, or the same bash `command` erroring twice |
| Abort + re-prompt | run ended via abort and the next prompt arrives |

On `agent_end`, after auto-retention, the last two turns (plus errored tool
names and truncated errors, capped at ~6000 chars) are sent to
`complete(ctx.model, …)` with a strict JSON-answer instruction
(`has_lesson`, `lesson`, `missing_context`, `correct_behavior`, `scope`,
`confidence`). Lessons with `confidence < 0.6` or `has_lesson=false` are
discarded. Surviving lessons are retained as one sentence to the bank picked
by `scope`, tagged `kind:lesson` (+ `project:<id>` for the user bank), context
`"self-learned lesson from a user correction"`. When a UI is present a
notification shows what was stored so it can be undone in Hindsight if wrong.
Everything is fire-and-forget; self-learning never surfaces as a session
error.

## `/learn` command

End-of-session retrospective: sends a prompt asking the model to review the
session for stated preferences, project decisions and corrections, store each
with `hindsight_remember`, and list what was stored.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `HINDSIGHT_API_URL` | `https://hindsight-api.josevictor.me` | Hindsight API base URL |
| `HINDSIGHT_API_TOKEN` | unset | Optional bearer token |
| `HINDSIGHT_USER_BANK` | `pi-agent-user` | User-wide bank id |
