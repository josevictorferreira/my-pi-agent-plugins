# hindsight

Long-term memory tools for pi, talking straight to a
[Hindsight](https://github.com/vectorize-io/hindsight) REST API (there is no
MCP server and no pi integration upstream — only claude-code/opencode plugins,
so the HTTP contract is reimplemented here).

## Tools

- `hindsight_recall` — search long-term memory (`POST /v1/default/banks/{bank}/memories/recall`, budget `mid`).
- `hindsight_retain` — store a fact (`POST /v1/default/banks/{bank}/memories`, `async: true` — synchronous ingestion runs LLM extraction inline and blows past any sane tool timeout).

`reflect` is deliberately not exposed: the upstream endpoint never returned on
the target deployment (a one-memory bank at budget "low" still hung after 10
minutes). Re-add it if that deployment's reflection backend starts working.

## Bank id

The memory bank is the git project's main-worktree basename (falls back to the
cwd basename outside git), matching what the opencode Hindsight plugin produces
with `dynamicBankGranularity=["gitProject"]` — so pi shares per-project banks
with the other agents.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `HINDSIGHT_API_URL` | `https://hindsight-api.josevictor.me` | Hindsight API base URL |
| `HINDSIGHT_API_TOKEN` | unset | Optional bearer token |
