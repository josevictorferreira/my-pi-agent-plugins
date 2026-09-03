import type { SkillExecutionState } from "./schemas";
import { serializeState } from "./state";

// Prompt shape follows the paper's Appendix A.4: a single user message, no
// system prompt, reasoning first, then one fenced JSON block.

const ACTION_VOCABULARY =
  '- {"type":"search_files","pattern":"<regex>","glob":"<optional file glob>"}  grep -rn under the repo root\n' +
  '- {"type":"read_file","path":"<relative>","offset":<line, 1-based>,"limit":<lines>}  read a file window\n' +
  '- {"type":"write_file","path":"<relative>","content":"<full text>"}  create or overwrite a file\n' +
  '- {"type":"patch_file","path":"<relative>","oldText":"<exact unique text>","newText":"<replacement>"}  replace one occurrence\n' +
  '- {"type":"exec_shell","command":"<sh -c command>","timeoutMs":<optional, max 120000>}  run a command in the repo root\n' +
  '- {"type":"git_diff","paths":["<optional relative paths>"]}  show uncommitted changes\n' +
  '- {"type":"finish","outcome":"completed"|"cannot_complete","summary":"<what was done and what remains>"}  end the run';

const STATE_RULES =
  "State update rules:\n" +
  '- "state_patch" is merged into the state. Only include keys you change.\n' +
  "- Object fields (facts, hypotheses): keys merge; set a key to null to delete it. Values are short free text.\n" +
  "- List fields (plan, blockers): the list you send replaces the old list entirely.\n" +
  "- Never send: version, step, statusSince, readsSinceWrite, objective, inspectedFiles, changedFiles, checks. They are runtime-owned.\n" +
  "- Before leaving a file, write what you learned into facts. You will not see this observation again.\n" +
  "- Limits: facts ≤ 24 keys (values ≤ 300 chars), hypotheses ≤ 12 keys (values ≤ 200 chars), plan and blockers ≤ 15 items, whole state ≤ 6 KB.\n" +
  "- Phases are enforced: after a third of the step budget (at most 30 steps), status must leave \"inspecting\"; \"planning\" lasts at most 2 steps and requires a non-empty plan, then status must be \"editing\" (entered with a plan; remove items as you finish them); in \"editing\", after 3 read-only actions without a write the next action must be write_file, patch_file or finish; \"testing\" requires a changed file. A reply that violates this is rejected and you are asked again.";

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
): string {
  let prompt =
    "Instructions:\n" +
    spec.trim() +
    "\n\n" +
    "Repository action vocabulary (JSON, exactly one per step):\n" +
    ACTION_VOCABULARY +
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
