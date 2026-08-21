import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_API_URL = "https://hindsight-api.josevictor.me";

// Auto-retention filters: skip trivial prompts ("ok", "yes", "continue") and
// cap item size so ingestion stays cheap on very long final responses.
const MIN_PROMPT_CHARS = 12;
const MAX_ITEM_CHARS = 8000;

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

/** Text blocks of a message, joined. Handles string and block-array content. */
function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  // --- Auto-retention -------------------------------------------------------
  //
  // Deterministic ingestion instead of a model-discretion retain tool: only
  // the user's own prompts and the final assistant response of each agent run
  // are stored — never intermediate turns, tool calls or tool results. One
  // async POST per run (extraction happens server-side, asynchronously).
  const pendingPrompts: string[] = [];

  pi.on("input", async (event: InputEvent) => {
    const text = event.text.trim();
    // Extension-injected inputs aren't "my own prompts"; slash commands and
    // trivial confirmations aren't worth remembering.
    if (event.source === "extension") return undefined;
    if (!text || text.startsWith("/") || text.length < MIN_PROMPT_CHARS) return undefined;
    pendingPrompts.push(text.slice(0, MAX_ITEM_CHARS));
    return undefined;
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const assistantMessages = event.messages.filter((m: any) => m?.role === "assistant");
    const finalText = messageText(assistantMessages[assistantMessages.length - 1]);

    const items = pendingPrompts
      .map((content) => ({ content, context: "user prompt" }))
      .concat(
        finalText
          ? [{ content: finalText.slice(0, MAX_ITEM_CHARS), context: "assistant final response" }]
          : [],
      );
    pendingPrompts.length = 0;
    if (items.length === 0) return;

    // Fire-and-forget: memory ingestion must never surface as a session error.
    try {
      await callApi(
        "hindsight_auto_retain",
        deriveBankId(ctx.cwd),
        "/memories",
        { items, async: true },
        undefined,
      );
    } catch {
      // Unreachable (callApi returns errors), but belt-and-braces.
    }
  });

  // --- Recall tool ----------------------------------------------------------

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
}
