import type { SkillExecutionState } from "./schemas";
import { serializeState } from "./state";

// Prompt shape follows the paper's Appendix A.4: reasoning first, then one
// fenced JSON block. The paper sends everything as one user message; here the
// byte-identical part (spec, action vocabulary, state rules) is sent as the
// system prompt instead, because that is where pi-ai puts the provider's
// prompt-cache marker. Over 4 KB of every prompt was identical and `cacheRead`
// was 0 for a whole 372-call run (improvements_3 §11).

const ACTION_VOCABULARY =
  '- {"type":"search_files","pattern":"<regex>","glob":"<optional glob>"}  code-first grep, ignored files excluded\n' +
  '- {"type":"read_file","path":"<relative>","offset":<line>,"limit":<lines>}\n' +
  '- {"type":"write_file","path":"<relative>","content":"<full text>"}\n' +
  '- {"type":"patch_file","path":"<relative>","oldText":"<exact unique text>","newText":"<replacement>"}\n' +
  '- {"type":"exec_shell","command":"<sh -c>","timeoutMs":<optional, max 120000>}\n' +
  '- {"type":"git_diff","paths":["<optional>"]}\n' +
  '- {"type":"finish","outcome":"completed"|"cannot_complete","summary":"<what changed, what remains>"}';

const STATE_RULES =
  "State update rules:\n" +
  '- "state_patch" is merged: send only keys you change. facts/hypotheses merge by key, null deletes; plan/blockers are replaced whole (arrays of strings, one "path: change" per item).\n' +
  "- status is one of: inspecting, planning, editing, testing, repairing. Runtime-owned, never send: version, step, statusSince, workSince, readsSinceWrite, lastWriteStep, objective, inspectedFiles, changedFiles, checks.\n" +
  "- Before leaving a file, write what you learned into facts; you will not see this observation again.\n" +
  "- The files you read or wrote most recently stay open (up to 4, within 8 KB): their current text is shown under \"Open files\" (or is the latest observation) and is refreshed after every edit. Reading lines that are already shown is rejected; copy oldText from the text shown.\n" +
  "- Limits: facts ≤ 40 (over that the oldest are dropped; values ≤ 600 chars; a longer value is cut, marked \" [CUT]\" and is no longer exact text), hypotheses ≤ 12 (≤ 200 chars, same), plan/blockers ≤ 15 items, state ≤ 12 KB. One idea per key; split long notes across keys.\n" +
  "- Enforced phases: leave inspecting within a third of the budget (max 30 steps); planning ≤ 2 steps and needs a plan whose items each name a file or a command; editing allows 3 actions that change nothing between writes (a rejected patch is one of them; exec_shell is not); testing needs a changed file and runs checks only — to edit, set status to editing or repairing first; editing, repairing and testing end after 12 steps without a file change, counted from the last change and not reset by a status change. Violations are rejected and you are asked again.";

const RESPONSE_FORMAT =
  "Provide your response with:\n" +
  "1. Step-by-step reasoning (will be discarded after execution)\n" +
  "2. A JSON block fenced with ```json containing both your State Patch and your Action.\n" +
  "   The JSON block MUST have exactly these two keys:\n" +
  '   { "state_patch": { ... }, "action": { ... } }';

/** The stable half is cacheable and sent once as the system prompt; the varying half is the user message. */
export interface RenderedPrompt {
  system: string;
  user: string;
}

export function render(
  spec: string,
  state: SkillExecutionState,
  observation: string,
  maxSteps: number,
  rejectionErrors?: string[],
  toolVocabulary?: string,
  openFiles?: string,
): RenderedPrompt {
  const system =
    "Instructions:\n" +
    spec.trim() +
    "\n\n" +
    "Repository action vocabulary (JSON, exactly one per step):\n" +
    ACTION_VOCABULARY +
    (toolVocabulary ? "\n" + toolVocabulary : "") +
    "\n\n" +
    STATE_RULES;
  let user =
    "Skill Execution State:\n```json\n" +
    serializeState(state) +
    "\n```\n\n" +
    (openFiles ? "Open files (current text, refreshed after every step; copy oldText from here instead of reading again):\n" + openFiles + "\n\n" : "") +
    "Latest Observation (you are on step " + (state.step + 1) + " of at most " + maxSteps + "):\n" +
    observation +
    "\n\n";
  if (rejectionErrors && rejectionErrors.length) {
    user +=
      "Previous response was rejected (state unchanged). Fix these and answer again:\n" +
      rejectionErrors.map((e) => "- " + e).join("\n") +
      "\n\n";
  }
  return { system, user: user + RESPONSE_FORMAT };
}

/** `start` is where the JSON begins in the reply; the text before it is the reasoning. */
export type ParsedReply = { ok: true; value: unknown; start: number } | { ok: false; error: string };

const NO_BLOCK =
  "no_json_block: the reply has no ```json block and no JSON object. Write your reasoning, then the fenced block with state_patch and action.";

/** Parse `raw` as JSON, else the widest {...} object inside it (prose around an unfenced block). */
function parseLoose(raw: string, offset: number, error: string): ParsedReply {
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      return { ok: true, value: JSON.parse(trimmed), start: offset };
    } catch {
      // fall through to the brace scan
    }
  }
  const close = raw.lastIndexOf("}");
  for (let open = raw.indexOf("{"); open !== -1 && open < close; open = raw.indexOf("{", open + 1)) {
    try {
      return { ok: true, value: JSON.parse(raw.slice(open, close + 1)), start: offset + open };
    } catch {
      // not the outermost brace; try the next one
    }
  }
  return { ok: false, error };
}

/**
 * The last closed ```json block. Failing that, an unclosed ```json opener
 * (the model stopped before the closing fence) or a bare {...} object after
 * the reasoning: both shapes were seen carrying complete, valid replies and
 * cost a full retry each.
 */
export function lastFencedJson(text: string): ParsedReply {
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g;
  let last: RegExpExecArray | undefined;
  for (let m = fence.exec(text); m; m = fence.exec(text)) last = m;
  if (last) {
    const body = last[1].trim();
    if (!body) return { ok: false, error: "no_json_block: the ```json block is empty" };
    try {
      return { ok: true, value: JSON.parse(body), start: last.index };
    } catch (err) {
      return { ok: false, error: "invalid_json: " + String((err as Error).message) };
    }
  }
  const open = text.lastIndexOf("```json");
  if (open !== -1) return parseLoose(text.slice(open + 7), open, "invalid_json: the ```json block is not closed and does not parse");
  return parseLoose(text, 0, NO_BLOCK);
}

/** Text the model wrote before its JSON (its reasoning), trimmed. */
export function reasoningText(text: string, jsonStart: number): string {
  return text.slice(0, jsonStart).trim();
}
