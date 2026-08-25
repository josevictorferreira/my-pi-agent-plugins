import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_API_URL = "https://context7.com/api";

// Server-side response cap, so a broad topic can't flood the context window.
const DEFAULT_DOC_TOKENS = 5000;

// Search returns dozens of near-duplicate mirrors; the top few are enough to pick from.
const MAX_SEARCH_RESULTS = 5;

interface SearchResult {
  id: string;
  title?: string | null;
  description?: string | null;
  totalSnippets?: number | null;
  trustScore?: number | null;
  benchmarkScore?: number | null;
  versions?: string[] | null;
  verified?: boolean | null;
}

function apiUrl(): string {
  return (process.env.CONTEXT7_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/**
 * GET a Context7 endpoint with a query string. `parse` picks the body handling:
 * search answers JSON, the docs endpoint answers plain text.
 */
async function callContext7(
  tool: string,
  path: string,
  params: Record<string, string>,
  parse: "json" | "text",
  signal: AbortSignal | undefined,
): Promise<{ data?: any; error?: string; status?: number }> {
  const headers: Record<string, string> = {};
  const key = process.env.CONTEXT7_API_KEY;
  // The API answers keyless at a low anonymous rate limit; the key raises it.
  if (key) headers.Authorization = "Bearer " + key;

  const timeout = AbortSignal.timeout(60000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(apiUrl() + path + "?" + new URLSearchParams(params), {
      method: "GET",
      headers,
      signal: abort,
    });
  } catch (err) {
    return { error: tool + " request failed: " + String(err) };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return {
      error: tool + " HTTP " + response.status + ": " + errText,
      status: response.status,
    };
  }

  return { data: parse === "json" ? await response.json() : await response.text() };
}

function errorResult(text: string, status?: number) {
  return {
    content: [{ type: "text" as const, text }],
    details: status !== undefined ? { status } : {},
    isError: true,
  };
}

/** One line of metadata for a search hit, skipping fields the API didn't fill in. */
function resultFacts(result: SearchResult): string {
  const facts: string[] = [];
  if (typeof result.trustScore === "number") facts.push("trust " + result.trustScore + "/10");
  if (typeof result.benchmarkScore === "number") facts.push("benchmark " + result.benchmarkScore);
  // -1 means "unknown", not "zero snippets".
  if (typeof result.totalSnippets === "number" && result.totalSnippets >= 0) {
    facts.push(result.totalSnippets + " snippets");
  }
  if (result.verified) facts.push("verified");
  if (result.versions?.length) facts.push("versions: " + result.versions.join(", "));
  return facts.join(", ");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "context7_resolve_library_id",
    label: "Resolve Library ID",
    description:
      "Search Context7 for a library or framework and get its Context7 library ID. " +
      "Call this before context7_query_docs unless the ID ('/org/project') is " +
      "already known.",
    promptSnippet: "Find a library's Context7 ID (step 1 before context7_query_docs)",
    promptGuidelines: [
      "Before explaining or writing code against any third-party library API, " +
        "configuration or migration, call context7_resolve_library_id (once per " +
        "library per session) then context7_query_docs; never answer such questions " +
        "from memory alone, even when you think you know the syntax.",
    ],
    parameters: Type.Object({
      library_name: Type.String({
        minLength: 1,
        description:
          "Official library or framework name, with its usual punctuation " +
          "('Next.js', not 'nextjs').",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate) {
      const { data, error, status } = await callContext7(
        "context7_resolve_library_id",
        "/v1/search",
        { query: params.library_name },
        "json",
        signal,
      );
      if (error) return errorResult(error, status);

      const results: SearchResult[] = data.results ?? [];
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No libraries matched '" + params.library_name + "'. Try the " +
                "official name with its usual punctuation, or a broader term.",
            },
          ],
          details: { resultCount: 0 },
        };
      }

      const blocks = results.slice(0, MAX_SEARCH_RESULTS).map((r) => {
        const facts = resultFacts(r);
        const head = "- " + r.id + (r.title ? " — " + r.title : "") + (facts ? " (" + facts + ")" : "");
        return r.description ? head + "\n  " + r.description : head;
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              "Context7 libraries matching '" + params.library_name + "':\n\n" +
              blocks.join("\n"),
          },
        ],
        details: { resultCount: results.length },
      };
    },
  });

  pi.registerTool({
    name: "context7_query_docs",
    label: "Query Library Docs",
    description:
      "Fetch up-to-date documentation and code examples for a library from " +
      "Context7. Prefer this over guessing API syntax from training data.",
    promptSnippet: "Current docs and code examples for a library, by Context7 ID",
    parameters: Type.Object({
      library_id: Type.String({
        minLength: 1,
        description:
          "Exact Context7 library ID from context7_resolve_library_id: " +
          "'/org/project', or '/org/project/version' to pin a version.",
      }),
      topic: Type.String({
        minLength: 1,
        description:
          "One specific concept to focus the docs on, e.g. 'useEffect cleanup' " +
          "rather than 'hooks'.",
      }),
      tokens: Type.Optional(
        Type.Integer({
          minimum: 500,
          maximum: 20000,
          description: "Response token budget (default 5000).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate) {
      // The ID goes in the path with its slashes intact; the model may drop the leading one.
      const libraryId = params.library_id.startsWith("/")
        ? params.library_id
        : "/" + params.library_id;

      const { data, error, status } = await callContext7(
        "context7_query_docs",
        "/v1" + libraryId,
        {
          type: "txt",
          topic: params.topic,
          tokens: String(params.tokens ?? DEFAULT_DOC_TOKENS),
        },
        "text",
        signal,
      );
      if (error) return errorResult(error, status);

      const text: string = (data ?? "").trim();
      if (!text) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No documentation found for topic '" + params.topic + "' in " +
                libraryId + ". Try a different topic or a broader term.",
            },
          ],
          details: { libraryId, topic: params.topic },
        };
      }

      // Already formatted for model consumption — relay it as-is.
      return {
        content: [{ type: "text" as const, text }],
        details: { libraryId, topic: params.topic },
      };
    },
  });
}
