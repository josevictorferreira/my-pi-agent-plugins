import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { execute, type ObservationKind, type ToolRunner } from "./executor";
import { lastFencedJson, reasoningText, render, type RenderedPrompt } from "./prompt";
import { relocateStrayFacts, validateStepResponse, type RepoAction, type SkillExecutionState, type StatePatch, type StepResponse } from "./schemas";
import { actionErrors, createInitialState, merge, recordAction, recordChanged, recordCheck, recordInspected, serializeState } from "./state";

// Algorithm 1 of the paper: A_t = (P, Σt, Ot) → (Rt, ΔΣt, at); Σt+1 = Σt ⊕ ΔΣt;
// Ot+1 = env(at). Rt (the reasoning text) is dropped after parsing.

// Rollback-retry budgets per step. "Hard" rejections are malformed or
// off-schema replies; "soft" ones are state bounds and phase policy, where the
// reply was fine and the runtime asked for a change. A run died on
// soft/soft/soft at one step and survived the identical sequence on resume
// only because the third attempt happened to be a write, so soft rejections
// get more room. The two budgets are independent: counting hard rejections
// against the soft budget too killed a run at soft/hard/hard/soft/soft.
const MAX_RETRIES = 2;
const MAX_SOFT_RETRIES = 4;
// Exhausting a step's retries discards that step (the model is told so and the
// step is spent) instead of ending the run: one died at step 67 of 500 with 4
// failing tests left, the next fix a one-line association. Only this many
// discarded steps per run; the stall guards bound the loop in between.
const MAX_DISCARDED_STEPS = 3;
export const DEFAULT_MAX_STEPS = 250;
// Transient provider failures (proxy 5xx/404, network resets) are retried a
// few times with backoff before the run is checkpointed and stopped.
const PROVIDER_ATTEMPTS = 4;
const PROVIDER_BACKOFF_MS = [2000, 8000, 20000];

export interface ModelReply {
  text: string;
  /** `reasoning` is the hidden-thinking subset of `output`, when the provider reports it. */
  usage?: { input: number; output: number; cacheRead: number; reasoning?: number };
}

export type CompleteFn = (prompt: RenderedPrompt, signal: AbortSignal) => Promise<ModelReply>;

export interface StepTelemetry {
  runId: string;
  step: number;
  status: SkillExecutionState["status"];
  actionType: RepoAction["type"];
  promptBytes: number;
  specBytes: number;
  stateBytes: number;
  observationBytes: number;
  input: number;
  output: number;
  cacheRead: number;
  retries: number;
  /** Why each rejected attempt was rejected (validation / merge errors). */
  rejections: string[];
  providerRetries: number;
  reReadCount: number;
  durationMs: number;
  /** Whether the action itself succeeded and what kind of observation it produced. */
  actionOk: boolean;
  observationKind: ObservationKind;
  /** Set for `tool` actions. */
  toolName?: string;
  /** Characters of reasoning before the JSON block in the accepted reply. */
  reasoningChars: number;
  /** Characters of the accepted reply. Compare with `output`: the gap is hidden reasoning. */
  replyChars: number;
  /** Hidden reasoning tokens across the step's attempts, when the provider reports them. */
  reasoningTokens?: number;
  // Everything below exists so the transcript can show what the step actually
  // did. The run log keeps the full action, state and observation; these are the
  // bounded projections the TUI renders, since session entries are kept small.
  /** The action with its target: `patch_file app/models/editor.rb`. */
  actionSummary: string;
  /** The observation's first meaningful line: `Patched …`, `Error: …`, `exit code 1`. */
  resultLine: string;
  /** Whether that line reports success. A shell command that ran but exited non-zero is not a success. */
  resultOk: boolean;
  /** Up to 12 lines / 800 chars of the observation. */
  observationPreview: string;
  /** Up to 300 chars of the reasoning the runtime discards after parsing. */
  reasoningHead: string;
  /** `editing → testing` when the accepted patch changed phase. */
  statusChange?: string;
  /** facts/hypotheses keys the accepted patch wrote, `-key` for a delete. */
  patchedKeys: string[];
  /** Plan items left after the merge. */
  planLeft: number;
  /** Files changed so far in the run. */
  changedCount: number;
}

/** Live position of a step, for a status line while the model is slow. */
export interface StepProgress {
  step: number;
  status: SkillExecutionState["status"];
  /** `thinking` while the model is being called, `acting` while the action runs. */
  phase: "thinking" | "acting";
  attempt: number;
  /** Set once the reply is accepted: the action about to run. */
  actionSummary?: string;
}

export type RunStatus = "completed" | "failed" | "cancelled";

/** Full trace of a run, for the per-run JSONL log. Emitted as it happens. */
export type RunEvent =
  | { type: "run_start"; runId: string; objective: string; maxSteps: number; resumedFrom?: number; spec: string; cwd: string; model?: string }
  | { type: "attempt"; step: number; attempt: number; prompt: string; reply: string; usage?: ModelReply["usage"]; errors: string[]; durationMs: number }
  | { type: "provider_error"; step: number; attempt: number; error: string; durationMs: number }
  | { type: "discarded_step"; step: number; retries: number; hardRejections: number; errors: string[]; usage: { input: number; output: number; cacheRead: number; reasoning: number } }
  | { type: "step"; step: number; action: RepoAction; statePatch: StatePatch; state: SkillExecutionState; observation: string; telemetry: StepTelemetry }
  | { type: "run_end"; summary: RunSummary };

/** Everything needed to continue a run from Σt with any model (paper Table 3). */
export interface Checkpoint {
  runId: string;
  objective: string;
  spec: string;
  maxSteps: number;
  state: SkillExecutionState;
  observation: string;
  totals: { input: number; output: number; cacheRead: number };
  reasoningTokens?: number;
  reReadCount: number;
  /** Set when the model itself ended the run with cannot_complete. */
  outcome?: "cannot_complete";
}

export interface RunSummary {
  runId: string;
  objective: string;
  status: RunStatus;
  maxSteps: number;
  /** Set when the model sent a finish action. */
  outcome?: "completed" | "cannot_complete";
  summary?: string;
  /** Runtime failure reason (invalid replies, provider error, step cap). */
  error?: string;
  steps: number;
  totals: { input: number; output: number; cacheRead: number };
  /** Hidden reasoning tokens (subset of totals.output), when the provider reports them. */
  reasoningTokens?: number;
  avgPromptTokens: number;
  maxPromptTokens: number;
  minPromptBytes: number;
  maxPromptBytes: number;
  reReadCount: number;
  changedFiles: string[];
  checks: SkillExecutionState["checks"];
  blockers: string[];
  /** Present when status is not "completed": resume with `/state-resume`. */
  checkpoint?: Checkpoint;
  /** Per-run JSONL trace, set by the extension entry point. */
  logPath?: string;
}

export interface RunOptions {
  runId: string;
  objective: string;
  spec: string;
  cwd: string;
  maxSteps: number;
  signal: AbortSignal;
  complete: CompleteFn;
  onStep: (telemetry: StepTelemetry, state: SkillExecutionState) => void;
  /** Continue from a checkpoint instead of Σ0 / workspace snapshot. */
  resume?: Checkpoint;
  /** Operator guidance delivered as the first observation of a resumed run. */
  resumeNote?: string;
  /** Trace sink (per-run JSONL log). */
  onEvent?: (event: RunEvent) => void;
  /** Model name, recorded in the run_start event only. */
  model?: string;
  /** Extension tools the model may call with the `tool` action. */
  tools?: ToolRunner & { vocabulary: string; validate: (name: string, params: unknown) => string[] };
  /** Reject (once per step) a reply that has no reasoning before the JSON block. */
  requireReasoning?: boolean;
  /** Called while a step is in flight, for a live status line. */
  onProgress?: (progress: StepProgress) => void;
}

const MAX_SUMMARY_CHARS = 120;
const MAX_RESULT_LINE_CHARS = 200;
const MAX_PREVIEW_LINES = 12;
const MAX_PREVIEW_CHARS = 800;
const MAX_REASONING_HEAD = 300;

/** The action and what it points at, in one line. */
export function describeAction(action: RepoAction): string {
  const detail = (() => {
    switch (action.type) {
      case "read_file":
        return action.path + (action.offset ? ":" + action.offset : "");
      case "search_files":
        return "/" + action.pattern + "/" + (action.glob ? " in " + action.glob : "");
      case "write_file":
      case "patch_file":
        return action.path;
      case "exec_shell":
        return action.command;
      case "git_diff":
        return (action.paths ?? []).join(" ");
      case "tool":
        return action.name;
      case "finish":
        return action.outcome + ": " + action.summary;
    }
  })();
  const label = action.type === "tool" ? "tool" : action.type;
  return (detail ? label + " " + detail : label).replace(/\s+/g, " ").slice(0, MAX_SUMMARY_CHARS);
}

/** The observation without its `Result of <action>:` header. */
function observationBody(observation: string): string {
  const firstLine = observation.indexOf("\n");
  return firstLine === -1 ? observation : observation.slice(firstLine + 1);
}

/** The line that says how the action went: for a shell command that is its exit status, not the command. */
function resultLineOf(action: RepoAction, body: string): string {
  const lines = body.split("\n").filter((l) => l.trim());
  const line = action.type === "exec_shell" ? (lines[1] ?? lines[0]) : lines[0];
  return (line ?? "").trim().slice(0, MAX_RESULT_LINE_CHARS);
}

/** A shell command that ran fine and failed is still a failure to whoever is watching. */
const FAILED_RESULT = /^(exit code [1-9]|timed out|aborted|Error\b)/;

function previewOf(body: string): string {
  return body.split("\n").slice(0, MAX_PREVIEW_LINES).join("\n").slice(0, MAX_PREVIEW_CHARS);
}

/** facts/hypotheses keys the patch wrote, `-key` for a delete. */
function patchedKeysOf(patch: StatePatch): string[] {
  return [...Object.entries(patch.facts ?? {}), ...Object.entries(patch.hypotheses ?? {})].map(
    ([key, value]) => (value === null ? "-" : "") + key,
  );
}

async function initialObservation(cwd: string, signal: AbortSignal): Promise<string> {
  const result = await execute(
    { type: "exec_shell", command: "git status --short 2>&1 | head -40; echo '--- top-level:'; ls -1" },
    cwd,
    signal,
  );
  return "Workspace: " + cwd + "\n" + result.observation.replace(/^Result of exec_shell:\n\$ [^\n]*\n[^\n]*\n/, "");
}

async function completeWithRetry(
  complete: CompleteFn,
  prompt: RenderedPrompt,
  signal: AbortSignal,
  onError: (attempt: number, error: string, durationMs: number) => void,
): Promise<{ reply: ModelReply; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      return { reply: await complete(prompt, signal), attempts: attempt };
    } catch (err) {
      lastError = err;
      onError(attempt, String((err as Error).message ?? err), Date.now() - started);
      if (signal.aborted || attempt === PROVIDER_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, PROVIDER_BACKOFF_MS[attempt - 1]));
    }
  }
  throw lastError;
}

/** A write that failed earlier, its error, and the file as it was then. */
interface FailedWrite {
  step: number;
  error: string;
  mtimeMs: number;
}

async function mtimeOf(cwd: string, path: string): Promise<number> {
  try {
    return (await stat(resolve(cwd, path))).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A byte-identical write that already failed against the same file contents
 * cannot do anything but fail again, so it is refused before it runs instead of
 * costing a step (one run repeated a single rejected patch 30 times). The file
 * is re-stat'd rather than assumed unchanged: something outside the run may
 * have edited it, and then the earlier failure says nothing.
 */
async function repeatedFailedWrite(
  failedWrites: Map<string, FailedWrite>,
  action: RepoAction,
  cwd: string,
): Promise<FailedWrite | undefined> {
  if (action.type !== "write_file" && action.type !== "patch_file") return undefined;
  const key = JSON.stringify(action);
  const earlier = failedWrites.get(key);
  if (!earlier) return undefined;
  if ((await mtimeOf(cwd, action.path)) === earlier.mtimeMs) return earlier;
  failedWrites.delete(key);
  return undefined;
}

/**
 * First line of a resumed run. Without it the model is handed the same state in
 * the same phase and repeats the segment that just failed: one resume spent 96
 * further steps on the loop that had exhausted the first budget (§11).
 */
function resumeHeader(state: SkillExecutionState): string {
  const idle = state.step - state.lastWriteStep;
  return (
    "You have been resumed at step " + (state.step + 1) + '; the previous segment ended in "' + state.status + '" and ' +
    (state.lastWriteStep
      ? "last changed a file at step " + state.lastWriteStep + " (" + idle + " steps before it stopped)"
      : "never changed a file") +
    ". Doing again what that segment did will end the same way: re-read what you are about to edit, or change approach."
  );
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const { runId, objective, spec, cwd, signal, complete, resume } = options;
  const specBytes = Buffer.byteLength(spec);
  let state = resume ? structuredClone(resume.state) : createInitialState(objective);
  // Checkpoints written before lastWriteStep existed resume as if nothing was written.
  state.lastWriteStep = state.lastWriteStep ?? 0;
  let observation = resume ? resume.observation : await initialObservation(cwd, signal);
  if (resume) {
    observation =
      resumeHeader(state) +
      (options.resumeNote ? "\n\nOperator note (act on this before anything else):\n" + options.resumeNote : "") +
      "\n\nPrevious observation:\n" + resume.observation;
  }
  const totals = resume ? { ...resume.totals } : { input: 0, output: 0, cacheRead: 0 };
  let promptTokenSum = 0;
  let maxPromptTokens = 0;
  let minPromptBytes = Infinity;
  let maxPromptBytes = 0;
  let reReadCount = resume?.reReadCount ?? 0;
  let reasoningTotal = resume?.reasoningTokens ?? 0;
  let reasoningReported = resume?.reasoningTokens !== undefined;
  let steps = state.step;
  const firstStep = steps;
  const emit = options.onEvent ?? (() => {});
  emit({ type: "run_start", runId, objective, maxSteps: options.maxSteps, resumedFrom: resume ? firstStep : undefined, spec, cwd, model: options.model });
  // Identical read/search actions return identical results until a file
  // changes; tell the model so instead of letting it loop (paper §7, cond. 2).
  const seenReads = new Map<string, number>();
  // The same applies to writes, and there it is provable: a byte-identical
  // write that failed against an unchanged file fails again. One run sent 22
  // distinct patches 158 times, one of them 30 times (improvements_3 §5).
  const failedWrites = new Map<string, FailedWrite>();
  // Path of a patch_file that failed on the previous step, if any.
  let lastFailedPatch: string | undefined;
  let discardedSteps = 0;

  const finish = (status: RunStatus, extra: Partial<RunSummary> = {}): RunSummary => {
    const own = steps - firstStep;
    const summary: RunSummary = {
      runId,
      objective,
      status,
      maxSteps: options.maxSteps,
      steps,
      totals,
      reasoningTokens: reasoningReported ? reasoningTotal : undefined,
      avgPromptTokens: own ? Math.round(promptTokenSum / own) : 0,
      maxPromptTokens,
      minPromptBytes: own ? minPromptBytes : 0,
      maxPromptBytes,
      reReadCount,
      changedFiles: [...state.changedFiles],
      checks: [...state.checks],
      blockers: [...state.blockers],
      checkpoint:
        status === "completed"
          ? undefined
          : {
              runId, objective, spec, maxSteps: options.maxSteps, state, observation, totals, reReadCount,
              reasoningTokens: reasoningReported ? reasoningTotal : undefined,
              outcome: extra.outcome === "cannot_complete" ? "cannot_complete" : undefined,
            },
      ...extra,
    };
    emit({ type: "run_end", summary });
    return summary;
  };

  while (steps < options.maxSteps) {
    if (signal.aborted) return finish("cancelled");
    const step = steps + 1;
    const started = Date.now();
    let retries = 0;
    let hardRejections = 0;
    let providerRetries = 0;
    const rejections: string[] = [];
    let errors: string[] | undefined;
    let accepted:
      | { response: StepResponse; next: SkillExecutionState; notices: string[]; reasoning: string; replyChars: number }
      | undefined;
    let reasoningAsked = false;
    let promptBytes = 0;
    let stateBytes = 0;
    let observationBytes = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };

    let discarded = false;

    // Rollback-retry: every attempt is a fresh (P, Σt, Ot [+ errors]) prompt.
    while (!accepted && !discarded) {
      const prompt = render(spec, state, observation, options.maxSteps, errors, options.tools?.vocabulary);
      promptBytes = Buffer.byteLength(prompt.system) + Buffer.byteLength(prompt.user);
      stateBytes = Buffer.byteLength(serializeState(state));
      observationBytes = Buffer.byteLength(observation);

      let reply: ModelReply;
      const attemptStarted = Date.now();
      let attemptNo = retries + 1;
      options.onProgress?.({ step, status: state.status, phase: "thinking", attempt: attemptNo });
      try {
        const attempt = await completeWithRetry(complete, prompt, signal, (n, error, durationMs) =>
          emit({ type: "provider_error", step, attempt: n, error, durationMs }),
        );
        reply = attempt.reply;
        providerRetries += attempt.attempts - 1;
      } catch (err) {
        if (signal.aborted) return finish("cancelled");
        return finish("failed", {
          error:
            "model call failed at step " + step + " after " + PROVIDER_ATTEMPTS + " attempts: " +
            String((err as Error).message ?? err),
        });
      }
      if (signal.aborted) return finish("cancelled");
      usage.input += reply.usage?.input ?? 0;
      usage.output += reply.usage?.output ?? 0;
      usage.cacheRead += reply.usage?.cacheRead ?? 0;
      if (reply.usage?.reasoning !== undefined) {
        reasoningReported = true;
        usage.reasoning += reply.usage.reasoning;
      }

      const parsed = lastFencedJson(reply.text);
      const relocated = parsed.ok ? relocateStrayFacts(parsed.value) : [];
      errors = parsed.ok ? validateStepResponse(parsed.value) : [parsed.error];
      let hard = errors.length > 0;
      const reasoning = parsed.ok ? reasoningText(reply.text, parsed.start) : "";
      if (!errors.length && options.requireReasoning && !reasoning && !reasoningAsked) {
        reasoningAsked = true;
        errors = ["no_reasoning: write your step-by-step reasoning before the ```json block, then the block"];
      }
      if (!errors.length && parsed.ok) {
        const response = parsed.value as StepResponse;
        if (response.action.type === "tool") {
          errors = options.tools ? options.tools.validate(response.action.name, response.action.params) : ["/action/type: no extension tools are available in this run"];
          hard = errors.length > 0;
        }
        if (!errors.length) {
          const merged = merge(state, response.state_patch, { maxSteps: options.maxSteps });
          if (!merged.ok) errors = merged.errors;
          else {
            errors = actionErrors(merged.state, response.action);
            const repeat = errors.length ? undefined : await repeatedFailedWrite(failedWrites, response.action, cwd);
            if (repeat) {
              errors = [
                "/action: this exact " + response.action.type + " already failed at step " + repeat.step +
                  " and no file has changed since, so it fails again. It was rejected with: " + repeat.error +
                  "\nSend a different action: read the region again and copy the text from the observation, or edit a different part of the file.",
              ];
              hard = true;
            }
            if (!errors.length) {
              accepted = { response, next: merged.state, notices: [...relocated, ...merged.notices], reasoning, replyChars: reply.text.length };
            }
          }
        }
      }
      emit({ type: "attempt", step, attempt: attemptNo, prompt: prompt.system + "\n\n" + prompt.user, reply: reply.text, usage: reply.usage, errors: errors ?? [], durationMs: Date.now() - attemptStarted });
      if (!accepted) {
        retries++;
        if (hard) hardRejections++;
        rejections.push((errors ?? []).join("; ").slice(0, 300));
        if (hardRejections > MAX_RETRIES || retries - hardRejections > MAX_SOFT_RETRIES) {
          const reason = "reply rejected " + retries + " times (" + hardRejections + " malformed): " + (errors ?? []).join("; ");
          if (++discardedSteps > MAX_DISCARDED_STEPS) {
            return finish("failed", { error: "step " + step + ": " + reason + " (" + discardedSteps + " steps discarded this run)" });
          }
          discarded = true;
          emit({ type: "discarded_step", step, retries, hardRejections, errors: errors ?? [], usage });
        }
      }
    }

    if (!accepted) {
      // Spend the step, keep Σt, and make the next prompt say what happened.
      state.step = step;
      steps = step;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      reasoningTotal += usage.reasoning;
      promptTokenSum += usage.input;
      maxPromptTokens = Math.max(maxPromptTokens, usage.input);
      observation =
        "Step " + step + " was discarded: your reply was rejected " + retries + " times and the state is unchanged. " +
        "Each attempt fixed one thing and broke another; send a minimal reply that satisfies all of these at once:\n" +
        rejections.map((r) => "- " + r).join("\n") +
        "\n\nPrevious observation:\n" + observation;
      continue;
    }

    // Commit Σt+1 (statusSince / readsSinceWrite were set by merge), then execute at.
    const statusBefore = state.status;
    state = accepted.next;
    state.step = step;
    steps = step;
    const { action } = accepted.response;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    reasoningTotal += usage.reasoning;
    promptTokenSum += usage.input;
    maxPromptTokens = Math.max(maxPromptTokens, usage.input);
    minPromptBytes = Math.min(minPromptBytes, promptBytes);
    maxPromptBytes = Math.max(maxPromptBytes, promptBytes);

    const actionSummary = describeAction(action);
    options.onProgress?.({ step, status: state.status, phase: "acting", attempt: retries + 1, actionSummary });
    const result = await execute(action, cwd, signal, options.tools);
    const body = observationBody(result.observation);
    const resultLine = resultLineOf(action, body);
    recordAction(state, action.type, result.changed !== undefined);
    if (action.type === "read_file" && result.inspected?.some((p) => state.inspectedFiles.includes(p))) reReadCount++;
    if (action.type === "read_file" || action.type === "search_files") {
      const key = JSON.stringify(action);
      const earlier = seenReads.get(key);
      if (earlier !== undefined) {
        // "Use facts instead" is right for structural knowledge and wrong right
        // after a failed patch: the model then patched from its own mangled
        // copy of the line it was looking at (improvements_3 §6).
        result.observation =
          (action.type === "read_file" && lastFailedPatch === action.path
            ? "Note: this exact action already ran at step " + earlier +
              ". Your last patch on this file failed: the text below is the file, copy oldText from it character for character, do not retype it from facts.\n"
            : "Note: this exact action already ran at step " + earlier + " and nothing changed since. " +
              "Record what you need in facts instead of repeating it.\n") + result.observation;
      }
      seenReads.set(key, step);
    } else if (result.changed) {
      seenReads.clear();
    }
    if (action.type === "write_file" || action.type === "patch_file") {
      if (result.changed) failedWrites.clear();
      else {
        failedWrites.set(JSON.stringify(action), {
          step,
          error: result.observation.split("\n").slice(0, 12).join("\n").slice(0, 800),
          mtimeMs: await mtimeOf(cwd, action.path),
        });
      }
    }
    lastFailedPatch = action.type === "patch_file" && !result.changed ? action.path : undefined;
    for (const path of result.inspected ?? []) recordInspected(state, path);
    if (result.changed) recordChanged(state, result.changed);
    if (result.check) recordCheck(state, result.check);
    // Runtime adjustments to the accepted patch (cut values) go in front of the
    // observation: the model will not see the rejected-style error, so this is
    // its only notice.
    observation = accepted.notices.length
      ? "Runtime notes:\n" + accepted.notices.map((n) => "- " + n).join("\n") + "\n\n" + result.observation
      : result.observation;

    const telemetry: StepTelemetry = {
      runId,
      step,
      status: state.status,
      actionType: action.type,
      promptBytes,
      specBytes,
      stateBytes,
      observationBytes,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      retries,
      rejections,
      providerRetries,
      reReadCount,
      durationMs: Date.now() - started,
      actionOk: result.kind !== "error",
      observationKind: result.kind,
      toolName: action.type === "tool" ? action.name : undefined,
      reasoningChars: accepted.reasoning.length,
      replyChars: accepted.replyChars,
      reasoningTokens: reasoningReported ? usage.reasoning : undefined,
      actionSummary,
      resultLine: resultLine.replace(/^Error: /, ""),
      resultOk: result.kind !== "error" && !FAILED_RESULT.test(resultLine),
      observationPreview: previewOf(body),
      reasoningHead: accepted.reasoning.slice(0, MAX_REASONING_HEAD),
      statusChange: state.status === statusBefore ? undefined : statusBefore + " → " + state.status,
      patchedKeys: patchedKeysOf(accepted.response.state_patch),
      planLeft: state.plan.length,
      changedCount: state.changedFiles.length,
    };
    emit({ type: "step", step, action, statePatch: accepted.response.state_patch, state, observation, telemetry });
    options.onStep(telemetry, state);

    if (action.type === "finish") {
      return finish(action.outcome === "completed" ? "completed" : "failed", {
        outcome: action.outcome,
        summary: action.summary,
      });
    }
  }
  return finish("failed", { error: "reached max steps (" + options.maxSteps + ") without finish; remaining plan: " + (state.plan.join("; ") || "none") });
}
