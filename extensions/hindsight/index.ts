import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { stateRunTool } from "../skill-state/tool-registry";

const DEFAULT_API_URL = "https://hindsight-api.josevictor.me";
const USER_BANK = process.env.HINDSIGHT_USER_BANK || "pi-agent-user";

// Opt-in auto-recall: inject memories relevant to each prompt so the model
// need not decide to call hindsight_recall. Budget is per bank (two banks) and
// paid on every prompt, so keep it small.
const AUTO_RECALL = process.env.HINDSIGHT_AUTO_RECALL === "1";
const AUTO_RECALL_MAX_TOKENS = 300;

// Auto-retention filters: skip trivial prompts ("ok", "yes", "continue") and
// cap item size so ingestion stays cheap on very long final responses.
const MIN_PROMPT_CHARS = 12;
const MAX_ITEM_CHARS = 8000;

// Self-learn caps: transcript fed to the lesson extractor, and the truncated
// error text per tool result.
const MAX_TRANSCRIPT_CHARS = 6000;
const MAX_ERROR_CHARS = 200;

// Lesson extraction: only keep lessons the model is reasonably sure about.
const MIN_LESSON_CONFIDENCE = 0.6;

// Auto-retrospective: wait for the agent to be idle this long after settling
// before distilling the session, and only once per session.
const RETROSPECTIVE_IDLE_MS = 120000;
const MIN_RETROSPECTIVE_CHARS = 200;
const MAX_RETROSPECTIVE_ITEMS = 10;

const USER_BANK_RETAIN_MISSION =
  "Extract only durable facts about the user: preferences, conventions, tools " +
  "they like or dislike, communication style, recurring decisions, and " +
  "lessons about how they want the agent to work. Ignore project " +
  "implementation details.";

interface RecallResult {
  text: string;
  type?: string | null;
  context?: string | null;
  mentioned_at?: string | null;
  scores?: { final?: number } | null;
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

/** Call a bank endpoint with a JSON body. Returns the parsed body or an error string. */
async function callApi(
  tool: string,
  bankId: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  method: "POST" | "PATCH" = "POST",
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
      method,
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

type Scope = "user" | "project" | "both";

/**
 * Recall from the user and/or project bank, merged, deduped by text and sorted
 * by score. `failures` lists banks that could not be reached; `hardFailure`
 * is set when none could.
 */
async function recall(
  query: string,
  scope: Scope,
  cwd: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
) {
  const banks: { label: string; bankId: string }[] = [];
  if (scope !== "user") banks.push({ label: "project", bankId: deriveBankId(cwd) });
  if (scope !== "project") banks.push({ label: "user", bankId: USER_BANK });

  const responses = await Promise.all(
    banks.map(async (bank) => ({
      bank,
      ...(await callApi(
        "hindsight_recall",
        bank.bankId,
        "/memories/recall",
        { query, budget: "mid", max_tokens: maxTokens },
        signal,
      )),
    })),
  );

  const failures = responses.filter((r) => r.error);
  const seen = new Set<string>();
  const merged: { label: string; result: RecallResult }[] = [];
  for (const r of responses) {
    if (r.error) continue;
    for (const result of r.data?.results ?? []) {
      if (seen.has(result.text)) continue;
      seen.add(result.text);
      merged.push({ label: r.bank.label, result });
    }
  }
  merged.sort((a, b) => (b.result.scores?.final ?? 0) - (a.result.scores?.final ?? 0));

  return {
    banks: banks.map((b) => b.bankId),
    merged,
    failures,
    hardFailure: responses.length > 0 && failures.length === responses.length,
  };
}

function formatMemory({ label, result }: { label: string; result: RecallResult }): string {
  const typeStr = result.type ? " [" + result.type + "]" : "";
  const dateStr = result.mentioned_at ? " (" + result.mentioned_at + ")" : "";
  return "- [" + label + "] " + result.text + typeStr + dateStr;
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

const KIND_CONTEXT: Record<string, string> = {
  preference: "user preference",
  decision: "project decision",
  lesson: "self-learned lesson from a user correction",
};

export default function (pi: ExtensionAPI) {
  // --- User bank setup ------------------------------------------------------
  //
  // Once per process, steer the user bank's extractor toward durable facts
  // about the user (not project details). Fire-and-forget like retention.
  let userBankConfigured = false;

  pi.on("session_start", async (_event: SessionStartEvent) => {
    if (userBankConfigured) return;
    userBankConfigured = true;
    try {
      await callApi(
        "hindsight_bank_config",
        USER_BANK,
        "/config",
        { retain_mission: USER_BANK_RETAIN_MISSION },
        undefined,
        "PATCH",
      );
    } catch {
      // Unreachable (callApi returns errors), but belt-and-braces.
    }
  });

  // --- Auto-retention -------------------------------------------------------
  //
  // Deterministic ingestion instead of a model-discretion retain tool: only
  // the user's own prompts and the final assistant response of each agent run
  // are stored — never intermediate turns, tool calls or tool results. One
  // async POST per run (extraction happens server-side, asynchronously).
  const pendingPrompts: string[] = [];

  // --- Self-learn autopilot state --------------------------------------------
  //
  // Per-run friction flags, reset on agent_end. A false positive costs one
  // LLM call that returns has_lesson=false, so the marker list stays tiny.
  const CORRECTION_MARKERS = [
    "no",
    "no,",
    "nope",
    "wrong",
    "not that",
    "actually",
    "i said",
    "i told you",
    "instead",
    "don't",
    "stop",
  ];
  let runHadFriction = false;
  let correctingPrompt: string | null = null;
  let erroredToolResults: { name: string; error: string }[] = [];
  const bashCommandErrors = new Map<string, number>();
  // Last completed run's prompt/answer, for the lesson transcript.
  let lastUserPrompt: string | null = null;
  let lastFinalAnswer: string | null = null;
  let lastRunAborted = false;

  // --- Auto-retrospective --------------------------------------------------
  //
  // Collect user prompts and assistant answers across the whole session;
  // once the agent has been idle for RETROSPECTIVE_IDLE_MS after settling,
  // distill durable preferences/decisions with a nested complete() call and
  // retain them. Runs at most once per session and never spawns an agent turn.
  const sessionTurns: string[] = [];
  let retrospectiveDone = false;
  let retrospectiveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRetrospective(ctx: ExtensionContext) {
    if (retrospectiveDone) return;
    if (retrospectiveTimer) clearTimeout(retrospectiveTimer);
    retrospectiveTimer = setTimeout(() => {
      retrospectiveTimer = null;
      if (retrospectiveDone) return;
      retrospectiveDone = true;
      runRetrospective(ctx, sessionTurns).catch(() => {
        // Fire-and-forget: never a session error.
      });
    }, RETROSPECTIVE_IDLE_MS);
  }

  pi.on("input", async (event: InputEvent) => {
    const text = event.text.trim();
    // Extension-injected inputs aren't "my own prompts"; slash commands and
    // trivial confirmations aren't worth remembering.
    if (event.source === "extension") return undefined;
    if (!text || text.startsWith("/") || text.length < MIN_PROMPT_CHARS) return undefined;
    pendingPrompts.push(text.slice(0, MAX_ITEM_CHARS));
    sessionTurns.push("User: " + text.slice(0, MAX_ITEM_CHARS));
    // Friction signal: the user correcting the previous run.
    const lower = text.toLowerCase();
    if (CORRECTION_MARKERS.some((m) => lower === m || lower.startsWith(m + " ") || lower.startsWith(m + ","))) {
      runHadFriction = true;
      correctingPrompt = text;
    } else if (lastRunAborted) {
      // Friction signal: previous run aborted and a new prompt arrived.
      runHadFriction = true;
      correctingPrompt = text;
    }
    lastRunAborted = false;
    return undefined;
  });

  if (AUTO_RECALL) {
    pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
      const text = event.prompt.trim();
      if (!text || text.startsWith("/") || text.length < MIN_PROMPT_CHARS) return undefined;
      const { merged } = await recall(text, "both", ctx.cwd, AUTO_RECALL_MAX_TOKENS, undefined);
      if (merged.length === 0) return undefined;
      return {
        message: {
          customType: "hindsight-recall",
          content:
            "Long-term memories relevant to this prompt (from hindsight):\n" +
            merged.map(formatMemory).join("\n"),
          display: false,
          details: { resultCount: merged.length },
        },
      };
    });
  }

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (!event.isError) return;
    const error = event.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join(" ")
      .slice(0, MAX_ERROR_CHARS);
    erroredToolResults.push({ name: (event as any).toolName ?? "unknown", error });

    // Same bash command erroring twice in one run is real friction; two or
    // more distinct errors in one run also count.
    const bashCommand = typeof (event.input as any)?.command === "string" ? (event.input as any).command : null;
    if (bashCommand) {
      const count = (bashCommandErrors.get(bashCommand) ?? 0) + 1;
      bashCommandErrors.set(bashCommand, count);
      if (count >= 2) runHadFriction = true;
    }
    if (erroredToolResults.length >= 2) runHadFriction = true;
    return undefined;
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const assistantMessages = event.messages.filter((m: any) => m?.role === "assistant");
    const finalMessage = assistantMessages[assistantMessages.length - 1];
    const finalText = messageText(finalMessage);
    const aborted = assistantMessages.some((m: any) => m?.stopReason === "aborted");
    lastRunAborted = aborted;

    const items = pendingPrompts
      .map((content) => ({ content, context: "user prompt" }))
      .concat(
        finalText
          ? [{ content: finalText.slice(0, MAX_ITEM_CHARS), context: "assistant final response" }]
          : [],
      );
    const userPrompt = pendingPrompts.length > 0 ? pendingPrompts[pendingPrompts.length - 1] : null;
    pendingPrompts.length = 0;

    // Fire-and-forget: memory ingestion must never surface as a session error.
    const projectBankId = deriveBankId(ctx.cwd);
    try {
      if (items.length > 0) {
        await callApi(
          "hindsight_auto_retain",
          projectBankId,
          "/memories",
          { items, async: true },
          undefined,
        );
      }
    } catch {
      // Unreachable (callApi returns errors), but belt-and-braces.
    }

    // --- Self-learn: extract and retain a lesson from the friction. ---------
    const friction = runHadFriction;
    const correction = correctingPrompt;
    const toolErrors = erroredToolResults.slice();
    runHadFriction = false;
    correctingPrompt = null;
    erroredToolResults = [];
    bashCommandErrors.clear();

    if (friction && ctx.model) {
      try {
        await extractAndStoreLesson(ctx, projectBankId, {
          previousPrompt: lastUserPrompt,
          previousAnswer: lastFinalAnswer,
          correctingPrompt: userPrompt ?? correction,
          toolErrors,
        });
      } catch {
        // Self-learning is best-effort; never a session error.
      }
    }

    lastUserPrompt = userPrompt;
    lastFinalAnswer = finalText || null;
    if (finalText) sessionTurns.push("Agent: " + finalText.slice(0, MAX_ITEM_CHARS));
  });

  // A new run means the user is not done; cancel any pending retrospective.
  pi.on("agent_start", async (_event: AgentStartEvent) => {
    if (retrospectiveTimer) {
      clearTimeout(retrospectiveTimer);
      retrospectiveTimer = null;
    }
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    scheduleRetrospective(ctx);
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    if (retrospectiveTimer) {
      clearTimeout(retrospectiveTimer);
      retrospectiveTimer = null;
    }
    // Quitting is the clearest end-of-session signal: distill now rather than
    // losing short sessions to the idle debounce. Best-effort, un-awaited.
    if (!retrospectiveDone && sessionTurns.join("\n\n").length >= MIN_RETROSPECTIVE_CHARS) {
      retrospectiveDone = true;
      runRetrospective(ctx, sessionTurns).catch(() => {
        // Fire-and-forget: never a session error.
      });
    }
  });

  // --- Recall tool ----------------------------------------------------------

  pi.registerTool(stateRunTool({
    name: "hindsight_recall",
    label: "Recall Memory",
    description:
      "Search long-term memory for relevant information. Memory is both " +
      "user-wide (preferences, conventions, lessons from any project) and " +
      "per-project (session history for this codebase). Use this proactively " +
      "before acting on anything the user might have a standing preference " +
      "about, and whenever a task resembles something that went wrong before.",
    promptSnippet:
      "Search long-term memory: user-wide preferences/lessons and this project's history",
    promptGuidelines: [
      "Call hindsight_recall before answering questions about prior sessions, " +
        "user preferences or past decisions — your context window does not carry them.",
      "Call hindsight_recall before acting on anything the user might have a " +
        "standing preference about, and when a task resembles something that " +
        "went wrong before; a stored lesson only helps if you recall it.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "Natural language search query; be specific about what you need.",
      }),
      scope: Type.Optional(
        StringEnum(["both", "project", "user"] as const, {
          description: "Which bank(s) to search: user-wide, this project, or both (default both).",
        }),
      ),
      max_tokens: Type.Optional(
        Type.Integer({
          minimum: 128,
          maximum: 16384,
          description: "Token budget for the returned memories (default 4096).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const { banks, merged, failures, hardFailure } = await recall(
        params.query,
        (params.scope ?? "both") as Scope,
        ctx.cwd,
        params.max_tokens ?? 4096,
        signal,
      );

      if (hardFailure) {
        const first = failures[0];
        return errorResult(first.error ?? "hindsight_recall failed", first.status);
      }

      if (merged.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No relevant memories found." }],
          details: { banks, resultCount: 0 },
        };
      }

      const lines = merged.map(formatMemory);

      const failureNote =
        failures.length > 0
          ? "\n\n(the " + failures.map((f) => f.bank.label).join(", ") + " bank could not be reached)"
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              "Found " + merged.length + " memories:\n\n" + lines.join("\n") + failureNote,
          },
        ],
        details: { banks, resultCount: merged.length },
      };
    },
  }));

  // --- Explicit memory store -------------------------------------------------

  pi.registerTool({
    name: "hindsight_retain",
    label: "Store Memory",
    description:
      "Explicitly store a durable fact in long-term memory. Use scope 'user' " +
      "whenever the user states a preference or convention that is not " +
      "specific to this repo ('always use bun', 'no em dashes', 'ask before " +
      "committing'); use scope 'project' for decisions about this codebase. " +
      "Use kind 'lesson' when you realise mid-run that you lacked context you " +
      "should have had.",
    promptSnippet: "Store a durable user preference, project decision or lesson",
    promptGuidelines: [
      "Use hindsight_retain (scope 'user') whenever the user states a " +
        "preference or convention that is not specific to this repo; use " +
        "scope 'project' for decisions about this codebase.",
    ],
    parameters: Type.Object({
      scope: StringEnum(["user", "project"] as const, {
        description: "user-wide memory or this-project memory.",
      }),
      kind: StringEnum(["preference", "decision", "lesson"] as const, {
        description: "What kind of memory this is.",
      }),
      content: Type.String({
        minLength: 8,
        description: "The fact/preference/decision/lesson to store, one or two sentences.",
      }),
      why: Type.Optional(
        Type.String({ description: "Optional short reason this is worth remembering." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const bankId = params.scope === "user" ? USER_BANK : deriveBankId(ctx.cwd);
      const content =
        params.why && params.why.trim()
          ? params.content + " — because " + params.why.trim()
          : params.content;
      const tags = ["kind:" + params.kind];
      if (params.scope === "user") tags.push("project:" + deriveBankId(ctx.cwd));

      const { error, status } = await callApi(
        "hindsight_retain",
        bankId,
        "/memories",
        { items: [{ content, context: KIND_CONTEXT[params.kind], tags }], async: true },
        undefined,
      );
      if (error) return errorResult(error, status);

      return {
        content: [
          { type: "text" as const, text: "Stored in " + params.scope + " bank (" + bankId + "): " + params.content },
        ],
        details: { bankId, scope: params.scope, kind: params.kind },
      };
    },
  });

  // --- /learn: end-of-session retrospective ----------------------------------

  pi.registerCommand("learn", {
    description: "Review this session and store preferences, decisions and lessons in long-term memory",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("Reviewing this session for memories to store…", "info");
      pi.sendUserMessage(
        "Run a retrospective over this session and store what matters using the " +
          "hindsight_retain tool:\n" +
          "1. User preferences or conventions the user stated (scope 'user', " +
          "kind 'preference') — anything not specific to this repo.\n" +
          "2. Project decisions made (scope 'project', kind 'decision').\n" +
          "3. Places you were corrected or went down a wrong path (kind 'lesson', " +
          "scope 'user' if the lesson generalizes, otherwise 'project').\n" +
          "Store each distinct item with one hindsight_retain call, then finish " +
          "with a short list of what was stored. Store nothing if there is nothing durable to store.",
      );
    },
  });
}

// --- Self-learn lesson extraction ---------------------------------------------

interface LessonTranscript {
  previousPrompt: string | null;
  previousAnswer: string | null;
  correctingPrompt: string | null;
  toolErrors: { name: string; error: string }[];
}

async function extractAndStoreLesson(
  ctx: ExtensionContext,
  projectBankId: string,
  t: LessonTranscript,
): Promise<void> {
  const parts: string[] = [];
  if (t.previousPrompt) parts.push("Previous user prompt:\n" + t.previousPrompt);
  if (t.previousAnswer) parts.push("Previous assistant answer:\n" + t.previousAnswer.slice(0, 2000));
  if (t.correctingPrompt) parts.push("Follow-up user prompt:\n" + t.correctingPrompt);
  if (t.toolErrors.length > 0) {
    parts.push(
      "Errored tool calls:\n" +
        t.toolErrors.map((e) => "- " + e.name + ": " + e.error).join("\n"),
    );
  }
  const transcript = parts.join("\n\n").slice(0, MAX_TRANSCRIPT_CHARS);
  if (!transcript) return;

  const systemPrompt =
    "You analyze an agent session that showed friction (a user correction, " +
    "repeated tool errors, or an aborted run). Decide whether there is a " +
    "durable lesson the agent was missing. Answer with ONLY a JSON object, " +
    "no prose, in exactly this shape:\n" +
    '{"has_lesson": boolean, "lesson": string, "missing_context": string, ' +
    '"correct_behavior": string, "scope": "user"|"project", "confidence": number}\n' +
    "scope is 'user' if the lesson generalizes across projects (a preference " +
    "or convention about how the agent should work), 'project' if it is " +
    "specific to this codebase. Set has_lesson=false when nothing durable " +
    "can be learned.";

  const response = await complete(ctx.model!, {
    systemPrompt,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  });
  const raw = messageText(response);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return;
  }

  if (!parsed?.has_lesson) return;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (confidence < MIN_LESSON_CONFIDENCE) return;
  const lesson = typeof parsed.lesson === "string" ? parsed.lesson.trim() : "";
  if (!lesson) return;

  const scope = parsed.scope === "user" ? "user" : "project";
  const behavior =
    typeof parsed.correct_behavior === "string" && parsed.correct_behavior.trim()
      ? parsed.correct_behavior.trim()
      : lesson;
  const missing =
    typeof parsed.missing_context === "string" && parsed.missing_context.trim()
      ? " because it did not know " + parsed.missing_context.trim()
      : "";

  const content =
    "When " +
    (t.correctingPrompt ? "a similar situation arises (" + lesson + ")" : lesson) +
    ", " +
    behavior +
    missing +
    ".";

  const bankId = scope === "user" ? USER_BANK : projectBankId;
  const tags = ["kind:lesson"];
  if (scope === "user") tags.push("project:" + projectBankId);

  const { error } = await callApi(
    "hindsight_self_learn",
    bankId,
    "/memories",
    { items: [{ content, context: KIND_CONTEXT.lesson, tags }], async: true },
    undefined,
  );
  if (error) return;

  if (ctx.hasUI) {
    ctx.ui.notify("Lesson stored: " + content.slice(0, 140), "info");
  }
}

// --- Auto-retrospective: silent /learn on every session -----------------------

async function runRetrospective(ctx: ExtensionContext, sessionTurns: string[]): Promise<void> {
  if (!ctx.model) return;
  const transcript = sessionTurns.join("\n\n").slice(0, MAX_ITEM_CHARS);
  if (transcript.length < MIN_RETROSPECTIVE_CHARS) return;

  const systemPrompt =
    "You review an agent session transcript and extract only durable facts " +
    "worth remembering for future sessions. Collect:\n" +
    "- user preferences or conventions stated by the user that are not " +
    "specific to this repo (scope 'user', kind 'preference')\n" +
    "- project decisions made for this codebase (scope 'project', kind 'decision')\n" +
    "- places the agent was corrected or went down a wrong path (kind 'lesson', " +
    "scope 'user' if it generalizes, otherwise 'project')\n" +
    "Answer with ONLY a JSON array, no prose, of at most " + MAX_RETROSPECTIVE_ITEMS +
    " objects in exactly this shape:\n" +
    '{"scope": "user"|"project", "kind": "preference"|"decision"|"lesson", ' +
    '"content": string, "confidence": number}\n' +
    "Store only things true across sessions; ignore one-off tasks, " +
    "implementation details and transient context. Return [] when there is " +
    "nothing durable.";

  const response = await complete(ctx.model, {
    systemPrompt,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  });

  const raw = messageText(response);
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return;

  let parsed: any;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  const projectBankId = deriveBankId(ctx.cwd);
  const items: {
    bankId: string;
    item: { content: string; context: string; tags: string[] };
  }[] = [];
  for (const entry of parsed) {
    if (typeof entry?.content !== "string" || entry.content.trim().length < 8) continue;
    if (entry.scope !== "user" && entry.scope !== "project") continue;
    if (entry.kind !== "preference" && entry.kind !== "decision" && entry.kind !== "lesson") continue;
    if (typeof entry.confidence !== "number" || entry.confidence < MIN_LESSON_CONFIDENCE) continue;

    const bankId = entry.scope === "user" ? USER_BANK : projectBankId;
    const tags = ["kind:" + entry.kind];
    if (entry.scope === "user") tags.push("project:" + projectBankId);
    items.push({
      bankId,
      item: { content: entry.content.trim().slice(0, MAX_ITEM_CHARS), context: KIND_CONTEXT[entry.kind], tags },
    });
  }
  if (items.length === 0) return;

  // One POST per bank, fire-and-forget.
  await Promise.all(
    [...new Set(items.map((i) => i.bankId))].map(async (bankId) => {
      await callApi(
        "hindsight_retrospective",
        bankId,
        "/memories",
        { items: items.filter((i) => i.bankId === bankId).map((i) => i.item), async: true },
        undefined,
      );
    }),
  );

  if (ctx.hasUI) {
    ctx.ui.notify(
      "Session retrospective: stored " + items.length + " item(s) to long-term memory.",
      "info",
    );
  }
}
