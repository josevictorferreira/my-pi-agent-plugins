# Implementation Plan: `web-tools` extension (web_search + web_fetch via Velox)

## Goal

Add a new pi extension at `extensions/web-tools/` exposing two tools,
`web_search` and `web_fetch`, both backed by the Velox proxy's Web endpoints
(`POST /v1/search`, `POST /v1/web/fetch`).

**Decision (deviates slightly from the README wishlist):** the README lists
"Web Search" and "Web Fetch" as two separate plugins, but both tools share the
same API base, auth, HTTP helper and error handling, so this plan ships them as
one `web-tools` extension with two registered tools. If you prefer two
directories, the tool code splits cleanly — say so and the plan adapts.

**Style anchor:** `extensions/hindsight/index.ts`. Match its structure exactly:
default-export factory, `callApi`-style fetch helper returning
`{ data?, error?, status? }`, `errorResult()` helper, typebox `Type.Object`
parameters, `type: "text" as const` content blocks, env-var configuration with
a hardcoded default URL.

## Velox API contract (verified against `https://velox.josevictor.me/docs/openapi.json`)

Base URL: `https://velox.josevictor.me`. Auth: `Authorization: Bearer <key>`
(Velox-issued client key, static allow-list). Every error response is an
OpenAI-shaped `{ "error": { ... } }` envelope.

### `POST /v1/search` — web search across a provider pool

Pool: SearXNG, Exa, Firecrawl, Tavily, Brave, Serper — walked in priority
order with fallback; a pinned `provider` never falls back.

Request body:

| Field | Type | Notes |
| --- | --- | --- |
| `query` | string, required | 1–500 chars, no control chars |
| `provider` | string | pin one configured provider |
| `max_results` | int 1–100 | default 5 |
| `search_type` | `"web"` \| `"news"` | default `"web"` |
| `country` / `language` | ISO codes | dropped by providers without equivalent |
| `time_range` | `any\|hour\|day\|week\|month\|year` | default `any` |
| `include_domains` / `exclude_domains` | string[], max 20 | |

Response: `{ provider, query, results: [{ title, url, snippet, position, score?, published_at? }], attempts }`.

### `POST /v1/web/fetch` — URL content extraction across a provider pool

Pool: Firecrawl, Exa, Jina Reader, Tavily. Extraction happens at the provider
(no direct SSRF surface). Providers that can't serve the requested `format`
are skipped.

Request body:

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string, required | must parse as http/https |
| `provider` | string | pin one provider, never falls back |
| `format` | `markdown\|html\|links` | default `markdown` |

Response: `{ provider, url, content, links?, metadata: { title?, description? }, attempts }`.

Relevant error statuses for both: 400 (validation), 401 (bad/missing key),
404 (named provider not configured / none support format), 429, 502 (pool
exhausted), 503.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | base URL, trailing slashes stripped |
| `VELOX_API_KEY` | (none) | bearer key; header only set when present |

Same pattern as `HINDSIGHT_API_URL` / `HINDSIGHT_API_TOKEN` in hindsight.

## Steps

### 1. Create `extensions/web-tools/index.ts` → verify: `bun run check` passes

Single file, structured like hindsight:

**Shared plumbing** (mirrors hindsight's `apiUrl`/`callApi`/`errorResult`):

- `apiUrl()` — `VELOX_API_URL` or default, trailing `/` stripped.
- `callVelox(tool, path, body, signal)` — POST JSON to `apiUrl() + path` with
  `Content-Type: application/json` and `Authorization: Bearer` when
  `VELOX_API_KEY` is set. 60s `AbortSignal.timeout` combined with the tool
  signal via `AbortSignal.any`. On non-OK, read the body and try to surface
  `error.message` from the OpenAI-shaped envelope (fall back to raw text).
  Returns `{ data?, error?, status? }`.
- `errorResult(text, status?)` — identical to hindsight's.

**Tool: `web_search`**

- `label: "Web Search"`; description tells the model to use it for current
  events, external facts, and finding documentation/URLs.
- Parameters (typebox) — expose only what an agent actually varies; everything
  else takes the server default (simplicity-first, no speculative knobs):
  - `query`: `Type.String({ minLength: 1, maxLength: 500 })`, required.
  - `max_results`: optional `Type.Integer({ minimum: 1, maximum: 100 })`,
    described as defaulting to 5 server-side.
  - `search_type`: optional `"web" | "news"` (typebox union of literals).
  - `time_range`: optional union `"any"|"hour"|"day"|"week"|"month"|"year"`.
  - Omit `provider`, `country`, `language`, `include_domains`,
    `exclude_domains` — not agent-useful; add later only if a real need shows.
- `execute`: build the body from the provided params only (no `undefined`
  keys — `additionalProperties: false` server-side makes stray keys a 400),
  call `/v1/search`, then render results as numbered lines:
  `1. <title>\n   <url>\n   <snippet>` plus `(published <date>)` when present.
  Empty `results` → non-error "No results for ..." text.
  `details: { provider: data.provider, resultCount, attempts }`.

**Tool: `web_fetch`**

- `label: "Web Fetch"`; description: retrieve the readable content of a URL
  (article text as markdown by default) — pair with `web_search` to read a
  result.
- Parameters:
  - `url`: `Type.String({ minLength: 1 })`, described as http/https only.
  - `format`: optional union `"markdown" | "html" | "links"`, default
    markdown (server-side).
- `execute`: validate nothing client-side beyond the schema (the server
  already rejects bad URLs with a clear 400 we relay), call `/v1/web/fetch`.
  - `format: "links"` → render `data.links` as one URL per line.
  - Otherwise render `data.content`, prefixed with a small header from
    `metadata.title` when present.
  - **Truncation:** cap returned content at ~50,000 chars (a page dump can
    blow the context window); append
    `\n\n[Content truncated at 50000 characters]` when cut. Constant
    `MAX_CONTENT_CHARS` at top of file, same spirit as hindsight's
    `MAX_ITEM_CHARS`.
  - `details: { provider, url: data.url, attempts, truncated }`.

**Optional prompt wiring** (hindsight sets these; keep them one line each):
`promptSnippet` naming both tools, and a `promptGuidelines` entry like
"Use web_search for information beyond your training data; use web_fetch to
read a specific URL before citing it."

### 2. Create `extensions/web-tools/README.md` → verify: covers both tools + config

Follow `extensions/hindsight/README.md` shape: what it does, the two tools
with their parameters, the two env vars, and a note that a `VELOX_API_KEY` is
required for authenticated deployments.

### 3. Update root `README.md` → verify: table row present, wishlist updated

- Add `web-tools` row to the Plugins table.
- Remove the now-shipped "Web Search" and "Web Fetch" bullets from the
  "New Plugins" wishlist.

### 4. Verification → all must pass before done

1. `bun run check` — typechecks clean.
2. Live smoke test against the real server (requires `VELOX_API_KEY` in env):
   - `curl -s -X POST "$VELOX_API_URL/v1/search" -H "Authorization: Bearer $VELOX_API_KEY" -H 'Content-Type: application/json' -d '{"query":"pi coding agent","max_results":3}'` returns 200 with results.
   - Same for `/v1/web/fetch` with `{"url":"https://example.com","format":"markdown"}`.
3. In-agent test: re-export the extension from a project's
   `.pi/extensions/`, run pi, ask it to search and then fetch a result;
   confirm both tool calls succeed and errors (e.g. unset key → 401) surface
   as readable tool errors, not crashes.

## Out of scope (intentionally)

- No caching, retries, or rate limiting client-side — Velox owns fallback and
  pooling (`attempts` in the response proves it).
- No `provider` pinning parameter until there's a concrete need.
- No use of Velox's LLM endpoints (`/v1/chat/completions` etc.); this
  extension only touches the Web tag.
