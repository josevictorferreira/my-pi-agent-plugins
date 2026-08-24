# web-tools

Web search and URL content extraction for pi, backed by the
[Velox](https://velox.josevictor.me/docs) proxy's Web endpoints. Velox owns
provider pooling and fallback — this extension is a thin client over
`POST /v1/search` and `POST /v1/web/fetch`.

Both tools live in one extension because they share the same base URL, auth,
HTTP helper and error handling.

## Tools

### `web_search`

Searches the web across Velox's provider pool (SearXNG, Exa, Firecrawl,
Tavily, Brave, Serper — walked in priority order with fallback).

| Parameter | Type | Notes |
| --- | --- | --- |
| `query` | string, required | 1–500 chars |
| `max_results` | integer 1–100 | server default 5 |
| `search_type` | `web` \| `news` | server default `web` |
| `time_range` | `any` \| `hour` \| `day` \| `week` \| `month` \| `year` | server default `any` |

Returns numbered results as `title` / `url` / `snippet`, with
`(published <date>)` when the provider reports one. `details` carries the
serving `provider`, `resultCount` and `attempts` (how many pool members were
tried).

Velox also accepts `provider`, `country`, `language`, `include_domains` and
`exclude_domains`; none are exposed here — add them when a real need shows up.

### `web_fetch`

Extracts the readable content of a URL across the fetch pool (Firecrawl, Exa,
Jina Reader, Tavily). Extraction happens at the provider, so there is no direct
SSRF surface.

| Parameter | Type | Notes |
| --- | --- | --- |
| `url` | string, required | must parse as http/https (server-validated) |
| `format` | `markdown` \| `html` \| `links` | server default `markdown` |

`markdown`/`html` return the content prefixed with the page title when the
provider reports one; `links` returns one URL per line. Content is capped at
`MAX_CONTENT_CHARS` (50000) with a truncation marker appended — a full page
dump otherwise blows the context window. `details` carries `provider`, `url`,
`attempts` and `truncated`.

## Errors

Velox returns OpenAI-shaped `{ "error": { "message": ... } }` envelopes; the
message is unwrapped and surfaced as a tool error with the HTTP status in
`details.status`. Common cases: 400 (validation), 401 (bad/missing key), 404
(named provider not configured, or none support the requested format), 429,
502 (pool exhausted), 503.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | Velox base URL, trailing slashes stripped |
| `VELOX_API_KEY` | unset | Bearer key; the header is only sent when set |

Authenticated deployments require `VELOX_API_KEY` — without it every call comes
back as a 401 tool error.
