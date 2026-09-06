import { execute, type ObservationKind, type ToolRunner } from "./executor";
import { lastFencedJson, reasoningText, render } from "./prompt";
import { validateStepResponse, type RepoAction, type SkillExecutionState, type StatePatch, type StepResponse } from "./schemas";
import { actionErrors, createInitialState, merge, recordAction, recordChanged, recordCheck, recordInspected, serializeState } from "./state";

// Algorithm 1 of the paper: A_t = (P, Σt, Ot) → (Rt, ΔΣt, at); Σt+1 = Σt ⊕ ΔΣt;
// Ot+1 = env(at). Rt (the reasoning text) is dropped after parsing.

// Rollback-retry budgets per step. "Hard" rejections are malformed or
// off-schema replies; "soft" ones are state bounds and phase policy, where the
// reply was fine and the runtime asked for a change. A run died on
// soft/soft/soft at one step and survived the identical sequence on resume
// only because the third attempt happened to be a write, so soft rejections
// get more room.
const MAX_RETRIES = 2;
const MAX_SOFT_RETRIES = 4;
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

export type CompleteFn = (prompt: string, signal: AbortSignal) => Promise<ModelReply>;

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
}

export type RunStatus = "completed" | "failed" | "cancelled";

/** Full trace of a run, for the per-run JSONL log. Emitted as it happens. */
export type RunEvent =
  | { type: "run_start"; runId: string; objective: string; maxSteps: number; resumedFrom?: number; spec: string; cwd: string; model?: string }
  | { type: "attempt"; step: number; attempt: number; prompt: string; reply: string; usage?: ModelReply["usage"]; errors: string[]; durationMs: number }
  | { type: "provider_error"; step: number; attempt: number; error: string; durationMs: number }
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
  prompt: string,
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

export async function run(options: RunOptions): Promise<RunSummary> {
  const { runId, objective, spec, cwd, signal, complete, resume } = options;
  const specBytes = Buffer.byteLength(spec);
  let state = resume ? structuredClone(resume.state) : createInitialState(objective);
  let observation = resume ? resume.observation : await initialObservation(cwd, signal);
  if (resume && options.resumeNote) {
    observation =
      "Operator note (the run was resumed; act on this before anything else):\n" + options.resumeNote +
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
      | { response: StepResponse; next: SkillExecutionState; notices: string[]; reasoningChars: number; replyChars: number }
      | undefined;
    let reasoningAsked = false;
    let promptBytes = 0;
    let stateBytes = 0;
    let observationBytes = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };

    // Rollback-retry: every attempt is a fresh (P, Σt, Ot [+ errors]) prompt.
    while (!accepted) {
      const prompt = render(spec, state, observation, options.maxSteps, errors, options.tools?.vocabulary);
      promptBytes = Buffer.byteLength(prompt);
      stateBytes = Buffer.byteLength(serializeState(state));
      observationBytes = Buffer.byteLength(observation);

      let reply: ModelReply;
      const attemptStarted = Date.now();
      let attemptNo = retries + 1;
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
            errors = actionErrors(merged.state, response.action.type);
            if (!errors.length) {
              accepted = { response, next: merged.state, notices: merged.notices, reasoningChars: reasoning.length, replyChars: reply.text.length };
            }
          }
        }
      }
      emit({ type: "attempt", step, attempt: attemptNo, prompt, reply: reply.text, usage: reply.usage, errors: errors ?? [], durationMs: Date.now() - attemptStarted });
      if (!accepted) {
        retries++;
        if (hard) hardRejections++;
        rejections.push((errors ?? []).join("; ").slice(0, 300));
        if (hardRejections > MAX_RETRIES || retries > MAX_SOFT_RETRIES) {
          return finish("failed", {
            error:
              "step " + step + ": reply rejected " + retries + " times (" + hardRejections + " malformed): " + (errors ?? []).join("; "),
          });
        }
      }
    }

    // Commit Σt+1 (statusSince / readsSinceWrite were set by merge), then execute at.
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

    const result = await execute(action, cwd, signal, options.tools);
    recordAction(state, action.type);
    if (action.type === "read_file" && result.inspected?.some((p) => state.inspectedFiles.includes(p))) reReadCount++;
    if (action.type === "read_file" || action.type === "search_files") {
      const key = JSON.stringify(action);
      const earlier = seenReads.get(key);
      if (earlier !== undefined) {
        result.observation =
          "Note: this exact action already ran at step " + earlier + " and nothing changed since. " +
          "Record what you need in facts instead of repeating it.\n" + result.observation;
      }
      seenReads.set(key, step);
    } else if (result.changed) {
      seenReads.clear();
    }
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
      reasoningChars: accepted.reasoningChars,
      replyChars: accepted.replyChars,
      reasoningTokens: reasoningReported ? usage.reasoning : undefined,
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
