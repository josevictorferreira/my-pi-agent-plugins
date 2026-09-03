import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stateRunTool } from "../skill-state/tool-registry";

const DEFAULT_API_URL = "https://velox.josevictor.me";

// A single page dump can blow the context window; cap what a fetch returns.
const MAX_CONTENT_CHARS = 50000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
  score?: number | null;
  published_at?: string | null;
}

function apiUrl(): string {
  return (process.env.VELOX_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** POST a JSON body to a Velox endpoint. Returns the parsed body or an error string. */
async function callVelox(
  tool: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<{ data?: any; error?: string; status?: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.VELOX_API_KEY;
  if (key) headers.Authorization = "Bearer " + key;

  const timeout = AbortSignal.timeout(60000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(apiUrl() + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abort,
    });
  } catch (err) {
    return { error: tool + " request failed: " + String(err) };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    // Errors come back as an OpenAI-shaped { error: { message } } envelope.
    let message = errText;
    try {
      message = JSON.parse(errText)?.error?.message || errText;
    } catch {
      // Not JSON — relay the raw body.
    }
    return {
      error: tool + " HTTP " + response.status + ": " + message,
      status: response.status,
    };
  }

  return { data: await response.json() };
}

function errorResult(text: string, status?: number) {
  return {
    content: [{ type: "text" as const, text }],
    details: status !== undefined ? { status } : {},
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(stateRunTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Use this for current events, facts beyond your training " +
      "data, and to find documentation or URLs to read with web_fetch.",
    promptSnippet: "Search the web for current information and URLs",
    promptGuidelines: [
      "Use web_search for current events, error messages and anything beyond your " +
        "training data; for third-party library docs use it only when context7 has " +
        "no match.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Search query; be specific.",
      }),
      max_results: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "How many results to return (default 5).",
        }),
      ),
      search_type: Type.Optional(
        Type.Union([Type.Literal("web"), Type.Literal("news")], {
          description: "Result kind (default 'web').",
        }),
      ),
      time_range: Type.Optional(
        Type.Union(
          [
            Type.Literal("any"),
            Type.Literal("hour"),
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ],
          { description: "Restrict results by recency (default 'any')." },
        ),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate) {
      // Only send the keys we were given — the server rejects unknown/undefined
      // properties with a 400.
      const body: Record<string, unknown> = { query: params.query };
      if (params.max_results !== undefined) body.max_results = params.max_results;
      if (params.search_type !== undefined) body.search_type = params.search_type;
      if (params.time_range !== undefined) body.time_range = params.time_range;

      const { data, error, status } = await callVelox("web_search", "/v1/search", body, signal);
      if (error) return errorResult(error, status);

      const results: SearchResult[] = data.results ?? [];
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: 'No results for "' + params.query + '".' }],
          details: { provider: data.provider, resultCount: 0, attempts: data.attempts },
        };
      }

      const lines = results.map((r, i) => {
        const published = r.published_at ? " (published " + r.published_at + ")" : "";
        return i + 1 + ". " + r.title + published + "\n   " + r.url + "\n   " + r.snippet;
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              results.length + " results for \"" + params.query + "\" via " + data.provider +
              ":\n\n" + lines.join("\n\n"),
          },
        ],
        details: { provider: data.provider, resultCount: results.length, attempts: data.attempts },
      };
    },
  }));

  pi.registerTool(stateRunTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Retrieve the readable content of a URL (article text as markdown by " +
      "default). Pair with web_search to read a result.",
    promptSnippet: "Read a URL's content as markdown",
    promptGuidelines: ["Use web_fetch to read a URL before citing or summarising it."],
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        description: "Absolute http or https URL.",
      }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("links")], {
          description:
            "'markdown' (default) or 'html' for page content, 'links' for the page's links.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate) {
      const body: Record<string, unknown> = { url: params.url };
      if (params.format !== undefined) body.format = params.format;

      const { data, error, status } = await callVelox("web_fetch", "/v1/web/fetch", body, signal);
      if (error) return errorResult(error, status);

      let text: string;
      if (params.format === "links") {
        const links: string[] = data.links ?? [];
        text = links.length > 0 ? links.join("\n") : "No links found at " + data.url + ".";
      } else {
        const title = data.metadata?.title;
        text = (title ? "# " + title + "\n\n" : "") + (data.content ?? "");
      }

      const truncated = text.length > MAX_CONTENT_CHARS;
      if (truncated) {
        text =
          text.slice(0, MAX_CONTENT_CHARS) +
          "\n\n[Content truncated at " + MAX_CONTENT_CHARS + " characters]";
      }

      return {
        content: [{ type: "text" as const, text }],
        details: { provider: data.provider, url: data.url, attempts: data.attempts, truncated },
      };
    },
  }));
}
