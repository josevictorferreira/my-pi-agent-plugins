# hindsight

Long-term memory for pi, talking straight to a
[Hindsight](https://github.com/vectorize-io/hindsight) REST API (there is no
MCP server and no pi integration upstream — only claude-code/opencode plugins,
so the HTTP contract is reimplemented here).

## What gets stored (auto-retention)

Storage is deterministic, not model-discretion — there is no retain tool.
Per agent run, exactly two kinds of content are ingested
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
  (`POST /v1/default/banks/{bank}/memories/recall`, budget `mid`).

`reflect` is deliberately not exposed: the upstream endpoint never returns on
the target deployment (still timing out after 45s as of 2026-08-21). Re-add it
if that deployment's reflection backend starts working.

## Bank id

Every git project gets its own bank: the bank id is the main-worktree basename
(linked worktrees share their repo's bank; outside git it falls back to the
cwd basename). Recall and retention both use the bank of the project pi is
running in. This matches what the opencode Hindsight plugin produces with
`dynamicBankGranularity=["gitProject"]`, so pi shares per-project banks with
the other agents.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `HINDSIGHT_API_URL` | `https://hindsight-api.josevictor.me` | Hindsight API base URL |
| `HINDSIGHT_API_TOKEN` | unset | Optional bearer token |
