# Implementation Plan: `context7` extension (up-to-date library docs)

## Goal

Add a new pi extension at `extensions/context7/` exposing two tools backed by
the Context7 REST API (`https://context7.com/api/v1`):

- `context7_resolve_library_id` — search Context7's index and resolve a
  package/framework name to a Context7 library ID (`/org/project`).
- `context7_query_docs` — fetch current documentation and code examples for a
  resolved library ID, scoped to a topic.

This mirrors the two tools Context7's official MCP server ships
(`resolve-library-id` / `query-docs`), but as a native pi extension — no MCP
transport, just the HTTP API the MCP server itself calls.

**Style anchor:** `extensions/hindsight/index.ts`. Match its structure exactly:
default-export factory `(pi: ExtensionAPI) => void`, a fetch helper returning
`{ data?, error?, status? }`, `errorResult()` helper, typebox `Type.Object`
parameters, `type: "text" as const` content blocks, env-var configuration with
a hardcoded default URL. One difference from hindsight's `callApi`: Context7
endpoints are **GET with query strings**, and the docs endpoint returns
**plain text**, not JSON — so the helper takes a query-param record and a
`parse: "json" | "text"` flag instead of a POST body.

## Context7 API contract (verified live on 2026-08-24 with the env key)

Base URL: `https://context7.com/api/v1`.
Auth: `Authorization: Bearer <key>` (keys look like `ctx7sk-...`). The API
answers without a key at a low anonymous rate limit; the key raises it — so
send the header only when `CONTEXT7_API_KEY` is set, same pattern as
`HINDSIGHT_API_TOKEN`.

### `GET /v1/search?query=<text>` — resolve a library

Response (JSON): `{ "results": [ ... ] }`, each result:

| Field | Notes |
| --- | --- |
| `id` | Context7 library ID, e.g. `/react-hook-form/react-hook-form` |
| `title`, `description` | display name + short summary |
| `totalSnippets` | code-example coverage (−1 when unknown) |
| `trustScore` | source reputation, 0–10 |
| `benchmarkScore` | quality score, 100 max |
| `versions` | optional list; a version-pinned ID is `/org/project/version` |
| `verified` | boolean |

Also present but not worth surfacing: `branch`, `lastUpdateDate`, `state`,
`stars`, `score`, `vip`, `totalTokens`.

### `GET /v1/{libraryId}?type=txt&topic=<text>&tokens=<n>` — fetch docs

`libraryId` goes in the path **without** URL-encoding its slashes
(`/v1/react-hook-form/react-hook-form?...`). Response is `text/plain`:
ready-to-read snippet blocks (`### <title>`, `Source: <url>`, prose, fenced
code). `topic` focuses the returned snippets; `tokens` caps response size
server-side. Empty/unknown IDs return a non-200 with an error body.

Relevant error statuses: 401/403 (bad key), 404 (unknown library), 429 (rate
limit).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CONTEXT7_API_URL` | `https://context7.com/api` | base URL, trailing slashes stripped |
| `CONTEXT7_API_KEY` | (none) | bearer key; header only set when present |

`CONTEXT7_API_KEY` is already exported in the user's environment — nothing to
provision.

## Steps

### 1. Create `extensions/context7/index.ts` → verify: `bun run check` passes

Single file, structured like hindsight:

**Shared plumbing**

- `apiUrl()` — `CONTEXT7_API_URL` or default, trailing `/` stripped.
- `callContext7(tool, path, params, parse, signal)` — GET
  `apiUrl() + path + "?" + new URLSearchParams(params)`, `Authorization`
  header when the key is set, 60s `AbortSignal.timeout` combined with the
  tool signal via `AbortSignal.any`. On non-OK, surface the body text as
  `error`. Returns `{ data?, error?, status? }` where `data` is parsed JSON
  or raw text per `parse`.
- `errorResult(text, status?)` — identical to hindsight's.
- Constant `DEFAULT_DOC_TOKENS = 5000` (server-side cap we pass by default so
  a broad topic can't flood the context window).

**Tool: `context7_resolve_library_id`**

- `label: "Resolve Library ID"`; description: search Context7 for a library
  or framework and get its Context7 ID — must be called before
  `context7_query_docs` unless the ID (`/org/project`) is already known.
- Parameters (typebox):
  - `library_name`: `Type.String({ minLength: 1 })` — official name with
    punctuation ("Next.js", not "nextjs").
- `execute`: GET `/v1/search` with `query: params.library_name`, take the top
  ~5 results, render one block per result:
  `- <id> — <title> (trust <trustScore>/10, benchmark <benchmarkScore>, <totalSnippets> snippets[, verified][, versions: ...])`
  followed by the description line. Empty `results` → non-error "No libraries
  matched ..." text suggesting a different name. `details: { resultCount }`.

**Tool: `context7_query_docs`**

- `label: "Query Library Docs"`; description: fetch up-to-date documentation
  and code examples for a library from Context7 — prefer this over guessing
  API syntax from training data.
- Parameters:
  - `library_id`: `Type.String({ minLength: 1 })` — exact Context7 ID from
    `context7_resolve_library_id` (`/org/project` or `/org/project/version`).
  - `topic`: `Type.String({ minLength: 1 })` — one specific concept, e.g.
    "useEffect cleanup", not "hooks".
  - `tokens`: optional `Type.Integer({ minimum: 500, maximum: 20000 })` —
    response budget, default 5000.
- `execute`: normalize `library_id` to a leading `/`, GET
  `/v1<library_id>` with `{ type: "txt", topic, tokens }`, `parse: "text"`.
  Return the text as-is (it's already formatted for model consumption);
  empty body → non-error "No documentation found for topic ..." text.
  `details: { libraryId, topic }`.

**Prompt wiring** (mirror hindsight, one line each):

- `promptSnippet`: "context7: resolve a library ID, then query current docs
  for any library/framework."
- `promptGuidelines` on `context7_query_docs`: "When answering questions
  about a library's API, configuration, or migration, query context7 docs
  instead of relying on training data — resolve the library ID first."

### 2. Create `extensions/context7/README.md` → verify: covers both tools + config

Follow `extensions/hindsight/README.md` shape: what it does, the two tools
with their parameters and the resolve-then-query workflow, the two env vars,
and a note that the API works keyless at a lower rate limit.

### 3. Update root `README.md` → verify: table row present, wishlist updated

- Add `context7` row to the Plugins table.
- Remove the "Context7" bullet from the "New Plugins" wishlist.

### 4. Verification → all must pass before done

1. `bun run check` — typechecks clean.
2. Live smoke test (key already in env):
   - `curl -s "https://context7.com/api/v1/search?query=react+hook+form" -H "Authorization: Bearer $CONTEXT7_API_KEY"` returns 200 with `results` (verified during planning).
   - `curl -s "https://context7.com/api/v1/react-hook-form/react-hook-form?type=txt&topic=validation&tokens=1500" -H "Authorization: Bearer $CONTEXT7_API_KEY"` returns plain-text snippets (verified during planning).
3. In-agent test: re-export the extension from a project's
   `.pi/extensions/`, run pi, ask a library question (e.g. "how do I do
   async validation in react-hook-form?"); confirm it resolves the ID, then
   queries docs, and that a bogus ID surfaces a readable tool error, not a
   crash.

## Out of scope (intentionally)

- No client-side caching of resolved IDs or docs — calls are cheap and the
  agent's context already holds recent results.
- No exposure of `versions` pinning as a separate parameter — the model can
  pass `/org/project/version` directly in `library_id` when it needs one.
- No retries/rate-limit backoff — a 429 is relayed as a readable tool error;
  the key's limit is generous for interactive use.
- No JSON `type` variants of the docs endpoint — `type=txt` is what the
  official MCP server returns to models, and it's already model-ready.
