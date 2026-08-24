# context7

Up-to-date library documentation for pi, talking straight to the
[Context7](https://context7.com) REST API (`https://context7.com/api/v1`).
Same two tools Context7's official MCP server ships, but as a native pi
extension — no MCP transport, just the HTTP API that server itself calls.

## Tools

Workflow is always resolve-then-query: a library ID is required to fetch docs,
and only the search endpoint knows them.

- `context7_resolve_library_id` — search Context7's index for a library or
  framework and get its Context7 ID (`GET /v1/search?query=...`).
  - `library_name` — official name with its usual punctuation ("Next.js", not
    "nextjs").
  - Returns the top 5 matches as `- /org/project — Title (trust, benchmark,
    snippet count, verified, versions)` plus the description, so the model can
    pick between mirrors. No match is a normal result, not an error.

- `context7_query_docs` — fetch current documentation and code examples for a
  resolved ID (`GET /v1/{libraryId}?type=txt&topic=...&tokens=...`).
  - `library_id` — exact ID from `context7_resolve_library_id`; a leading `/` is
    added if missing. Pass `/org/project/version` to pin a version (the
    `versions` list from search shows what's available).
  - `topic` — one specific concept ("useEffect cleanup", not "hooks"); it
    focuses which snippets come back.
  - `tokens` — optional response budget, 500–20000, default 5000. The cap is
    applied server-side, so a broad topic can't flood the context window.
  - The response is `text/plain` snippet blocks (`### title`, `Source: <url>`,
    prose, fenced code), already formatted for model consumption and relayed
    as-is.

An unknown library ID comes back as a readable tool error (HTTP 404 with the
API's own message), as do 401/403 (bad key) and 429 (rate limit) — there are no
retries or backoff.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CONTEXT7_API_URL` | `https://context7.com/api` | API base URL, trailing slashes stripped |
| `CONTEXT7_API_KEY` | unset | Bearer key (`ctx7sk-...`); header only sent when set |

The API answers without a key at a low anonymous rate limit — the key just
raises it, so the extension works unconfigured.
