import type { SkillExecutionState } from "./schemas";
import { serializeState } from "./state";

// Prompt shape follows the paper's Appendix A.4: a single user message, no
// system prompt, reasoning first, then one fenced JSON block.

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
  '- "state_patch" is merged: send only keys you change. facts/hypotheses merge by key, null deletes; plan/blockers are replaced whole.\n' +
  "- status is one of: inspecting, planning, editing, testing, repairing. Runtime-owned, never send: version, step, statusSince, readsSinceWrite, objective, inspectedFiles, changedFiles, checks.\n" +
  "- Before leaving a file, write what you learned into facts; you will not see this observation again.\n" +
  "- Limits: facts ≤ 40 (values ≤ 300 chars), hypotheses ≤ 12 (≤ 200 chars), plan/blockers ≤ 15 items, state ≤ 12 KB.\n" +
  "- Enforced phases: leave inspecting within a third of the budget (max 30 steps); planning ≤ 2 steps and needs a plan whose items each name a file or a command; editing allows 3 read-only actions between writes; testing needs a changed file. Violations are rejected and you are asked again.";

const RESPONSE_FORMAT =
  "Provide your response with:\n" +
  "1. Step-by-step reasoning (will be discarded after execution)\n" +
  "2. A JSON block fenced with ```json containing both your State Patch and your Action.\n" +
  "   The JSON block MUST have exactly these two keys:\n" +
  '   { "state_patch": { ... }, "action": { ... } }';

export function render(
  spec: string,
  state: SkillExecutionState,
  observation: string,
  maxSteps: number,
  rejectionErrors?: string[],
  toolVocabulary?: string,
): string {
  let prompt =
    "Instructions:\n" +
    spec.trim() +
    "\n\n" +
    "Repository action vocabulary (JSON, exactly one per step):\n" +
    ACTION_VOCABULARY +
    (toolVocabulary ? "\n" + toolVocabulary : "") +
    "\n\n" +
    STATE_RULES +
    "\n\n" +
    "Skill Execution State:\n```json\n" +
    serializeState(state) +
    "\n```\n\n" +
    "Latest Observation (you are on step " + (state.step + 1) + " of at most " + maxSteps + "):\n" +
    observation +
    "\n\n";
  if (rejectionErrors && rejectionErrors.length) {
    prompt +=
      "Previous response was rejected (state unchanged). Fix these and answer again:\n" +
      rejectionErrors.map((e) => "- " + e).join("\n") +
      "\n\n";
  }
  return prompt + RESPONSE_FORMAT;
}

export type ParsedReply = { ok: true; value: unknown } | { ok: false; error: string };

/** Take the last ```json fenced block; fall back to the whole text as JSON. */
export function lastFencedJson(text: string): ParsedReply {
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g;
  let last: string | undefined;
  for (let m = fence.exec(text); m; m = fence.exec(text)) last = m[1];
  const candidate = (last ?? text).trim();
  if (!candidate) return { ok: false, error: "no_json_block: reply contained no ```json block" };
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (err) {
    return {
      ok: false,
      error: (last === undefined ? "no_json_block: " : "invalid_json: ") + String((err as Error).message),
    };
  }
}

/** Text the model wrote before the last fenced JSON block (its reasoning), trimmed. */
export function reasoningText(text: string): string {
  const idx = text.lastIndexOf("```json");
  const before = idx === -1 ? "" : text.slice(0, idx);
  return before.trim();
}
