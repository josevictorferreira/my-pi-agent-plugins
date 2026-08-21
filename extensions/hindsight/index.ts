import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_API_URL = "https://hindsight-api.josevictor.me";

interface RecallResult {
  text: string;
  type?: string | null;
  context?: string | null;
  mentioned_at?: string | null;
}

// cwd -> bank id. `git rev-parse` is cheap but not free, and cwd rarely
// changes within a session.
const bankCache = new Map<string, string>();

/**
 * Main-worktree basename for a directory, so linked worktrees of one repo
 * share a bank. Falls back to the cwd basename outside git.
 */
function deriveBankId(cwd: string): string {
  const cached = bankCache.get(cwd);
  if (cached) return cached;

  let bankId = cwd ? basename(cwd) : "unknown";
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      },
    ).trim();
    if (commonDir) {
      // Ordinary clones and `git worktree add` report `<root>/.git`; a bare
      // repo reports the bare dir itself.
      bankId = basename(commonDir) === ".git" ? basename(dirname(commonDir)) : basename(commonDir);
    }
  } catch {
    // git missing or not a repo — keep the cwd basename.
  }

  bankCache.set(cwd, bankId);
  return bankId;
}

function apiUrl(): string {
  return (process.env.HINDSIGHT_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** POST a JSON body to a bank endpoint. Returns the parsed body or an error string. */
async function callApi(
  tool: string,
  bankId: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<{ data?: any; error?: string; status?: number }> {
  const url = apiUrl() + "/v1/default/banks/" + encodeURIComponent(bankId) + path;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.HINDSIGHT_API_TOKEN;
  if (token) headers.Authorization = "Bearer " + token;

  const timeout = AbortSignal.timeout(60000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
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
    return {
      error: tool + " HTTP " + response.status + ": " + errText,
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
  pi.registerTool({
    name: "hindsight_recall",
    label: "Recall Memory",
    description:
      "Search long-term memory for relevant information. Use this proactively " +
      "before answering questions about past sessions, user preferences, project " +
      "history or earlier decisions. When in doubt, recall first.",
    promptSnippet:
      "hindsight_recall: search long-term memory of past sessions for this project.",
    promptGuidelines: [
      "Call hindsight_recall before answering questions about prior sessions, " +
        "user preferences or past decisions — your context window does not carry them.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "Natural language search query; be specific about what you need.",
      }),
      max_tokens: Type.Optional(
        Type.Integer({
          minimum: 128,
          maximum: 16384,
          description: "Token budget for the returned memories (default 4096).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const bankId = deriveBankId(ctx.cwd);
      const { data, error, status } = await callApi(
        "hindsight_recall",
        bankId,
        "/memories/recall",
        {
          query: params.query,
          budget: "mid",
          max_tokens: params.max_tokens ?? 4096,
        },
        signal,
      );
      if (error) return errorResult(error, status);

      const results: RecallResult[] = data.results ?? [];
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No relevant memories found in bank " + bankId + "." }],
          details: { bankId, resultCount: 0 },
        };
      }

      const lines = results.map((r) => {
        const typeStr = r.type ? " [" + r.type + "]" : "";
        const dateStr = r.mentioned_at ? " (" + r.mentioned_at + ")" : "";
        return "- " + r.text + typeStr + dateStr;
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              "Found " + results.length + " memories in bank " + bankId + ":\n\n" +
              lines.join("\n"),
          },
        ],
        details: { bankId, resultCount: results.length },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Retain Memory",
    description:
      "Store information in long-term memory. Use this to remember important " +
      "facts, user preferences, project context and decisions worth recalling in " +
      "future sessions. Be specific — include who, what, when and why.",
    promptSnippet:
      "hindsight_retain: store a fact in long-term memory for future sessions.",
    promptGuidelines: [
      "Call hindsight_retain when you learn something durable — a preference, a " +
        "convention, a decision and its reason — not for transient task state.",
    ],
    parameters: Type.Object({
      content: Type.String({
        minLength: 1,
        description: "The information to remember. Be specific and self-contained.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional context about where this information came from.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const bankId = deriveBankId(ctx.cwd);
      const { data, error, status } = await callApi(
        "hindsight_retain",
        bankId,
        "/memories",
        {
          items: [
            {
              content: params.content,
              context: params.context,
            },
          ],
          // Synchronous ingestion runs LLM extraction inline and blows past
          // any sane tool timeout (measured >60s against the live API), so
          // queue it instead: the memory becomes recallable shortly after.
          async: true,
        },
        signal,
      );
      if (error) return errorResult(error, status);

      return {
        content: [
          {
            type: "text" as const,
            text: "Memory queued for bank " + bankId + " (extraction runs asynchronously).",
          },
        ],
        details: { bankId, itemsCount: data.items_count ?? 1, operationId: data.operation_id },
      };
    },
  });
}
