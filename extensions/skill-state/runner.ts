import { execute } from "./executor";
import { lastFencedJson, render } from "./prompt";
import { validateStepResponse, type RepoAction, type SkillExecutionState, type StepResponse } from "./schemas";
import { createInitialState, merge, recordChanged, recordCheck, recordInspected, serializeState } from "./state";

// Algorithm 1 of the paper: A_t = (P, Σt, Ot) → (Rt, ΔΣt, at); Σt+1 = Σt ⊕ ΔΣt;
// Ot+1 = env(at). Rt (the reasoning text) is dropped after parsing.

const MAX_RETRIES = 2;
export const DEFAULT_MAX_STEPS = 40;
// Transient provider failures (proxy 5xx/404, network resets) are retried a
// few times with backoff before the run is checkpointed and stopped.
const PROVIDER_ATTEMPTS = 3;
const PROVIDER_BACKOFF_MS = [1000, 4000];

export interface ModelReply {
  text: string;
  usage?: { input: number; output: number; cacheRead: number };
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
}

export type RunStatus = "completed" | "failed" | "cancelled";

/** Everything needed to continue a run from Σt with any model (paper Table 3). */
export interface Checkpoint {
  runId: string;
  objective: string;
  spec: string;
  maxSteps: number;
  state: SkillExecutionState;
  observation: string;
  totals: { input: number; output: number; cacheRead: number };
  reReadCount: number;
}

export interface RunSummary {
  runId: string;
  objective: string;
  status: RunStatus;
  /** Set when the model sent a finish action. */
  outcome?: "completed" | "cannot_complete";
  summary?: string;
  /** Runtime failure reason (invalid replies, provider error, step cap). */
  error?: string;
  steps: number;
  totals: { input: number; output: number; cacheRead: number };
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
): Promise<{ reply: ModelReply; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt++) {
    try {
      return { reply: await complete(prompt, signal), attempts: attempt };
    } catch (err) {
      lastError = err;
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
  const totals = resume ? { ...resume.totals } : { input: 0, output: 0, cacheRead: 0 };
  let promptTokenSum = 0;
  let maxPromptTokens = 0;
  let minPromptBytes = Infinity;
  let maxPromptBytes = 0;
  let reReadCount = resume?.reReadCount ?? 0;
  let steps = state.step;
  const firstStep = steps;
  // Identical read/search actions return identical results until a file
  // changes; tell the model so instead of letting it loop (paper §7, cond. 2).
  const seenReads = new Map<string, number>();

  const finish = (status: RunStatus, extra: Partial<RunSummary> = {}): RunSummary => {
    const own = steps - firstStep;
    return {
      runId,
      objective,
      status,
      steps,
      totals,
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
          : { runId, objective, spec, maxSteps: options.maxSteps, state, observation, totals, reReadCount },
      ...extra,
    };
  };

  while (steps < options.maxSteps) {
    if (signal.aborted) return finish("cancelled");
    const step = steps + 1;
    const started = Date.now();
    let retries = 0;
    let providerRetries = 0;
    const rejections: string[] = [];
    let errors: string[] | undefined;
    let accepted: { response: StepResponse; next: SkillExecutionState } | undefined;
    let promptBytes = 0;
    let stateBytes = 0;
    let observationBytes = 0;
    const usage = { input: 0, output: 0, cacheRead: 0 };

    // Rollback-retry: every attempt is a fresh (P, Σt, Ot [+ errors]) prompt.
    while (!accepted) {
      const prompt = render(spec, state, observation, options.maxSteps, errors);
      promptBytes = Buffer.byteLength(prompt);
      stateBytes = Buffer.byteLength(serializeState(state));
      observationBytes = Buffer.byteLength(observation);

      let reply: ModelReply;
      try {
        const attempt = await completeWithRetry(complete, prompt, signal);
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

      const parsed = lastFencedJson(reply.text);
      errors = parsed.ok ? validateStepResponse(parsed.value) : [parsed.error];
      if (!errors.length && parsed.ok) {
        const response = parsed.value as StepResponse;
        const merged = merge(state, response.state_patch);
        if (merged.ok) accepted = { response, next: merged.state };
        else errors = merged.errors;
      }
      if (!accepted) {
        retries++;
        rejections.push((errors ?? []).join("; ").slice(0, 300));
        if (retries > MAX_RETRIES) {
          return finish("failed", {
            error: "step " + step + ": reply rejected " + retries + " times: " + (errors ?? []).join("; "),
          });
        }
      }
    }

    // Commit Σt+1, then execute at.
    state = accepted.next;
    state.step = step;
    steps = step;
    const { action } = accepted.response;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    promptTokenSum += usage.input;
    maxPromptTokens = Math.max(maxPromptTokens, usage.input);
    minPromptBytes = Math.min(minPromptBytes, promptBytes);
    maxPromptBytes = Math.max(maxPromptBytes, promptBytes);

    const result = await execute(action, cwd, signal);
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
    observation = result.observation;

    options.onStep(
      {
        runId,
        step,
        status: state.status,
        actionType: action.type,
        promptBytes,
        specBytes,
        stateBytes,
        observationBytes,
        ...usage,
        retries,
        rejections,
        providerRetries,
        reReadCount,
        durationMs: Date.now() - started,
      },
      state,
    );

    if (action.type === "finish") {
      return finish(action.outcome === "completed" ? "completed" : "failed", {
        outcome: action.outcome,
        summary: action.summary,
      });
    }
  }
  return finish("failed", { error: "reached max steps (" + options.maxSteps + ") without finish" });
}
