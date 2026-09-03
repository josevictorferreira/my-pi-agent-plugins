import { execute } from "./executor";
import { lastFencedJson, render } from "./prompt";
import { validateStepResponse, type RepoAction, type SkillExecutionState, type StepResponse } from "./schemas";
import { createInitialState, merge, recordChanged, recordCheck, recordInspected, serializeState } from "./state";

// Algorithm 1 of the paper: A_t = (P, Σt, Ot) → (Rt, ΔΣt, at); Σt+1 = Σt ⊕ ΔΣt;
// Ot+1 = env(at). Rt (the reasoning text) is dropped after parsing.

const MAX_RETRIES = 2;
export const DEFAULT_MAX_STEPS = 40;

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
  reReadCount: number;
  durationMs: number;
}

export type RunStatus = "completed" | "failed" | "cancelled";

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
}

async function initialObservation(cwd: string, signal: AbortSignal): Promise<string> {
  const result = await execute(
    { type: "exec_shell", command: "git status --short 2>&1 | head -40; echo '--- top-level:'; ls -1" },
    cwd,
    signal,
  );
  return "Workspace: " + cwd + "\n" + result.observation.replace(/^Result of exec_shell:\n\$ [^\n]*\n[^\n]*\n/, "");
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const { runId, objective, spec, cwd, signal, complete } = options;
  const specBytes = Buffer.byteLength(spec);
  let state = createInitialState(objective);
  let observation = await initialObservation(cwd, signal);
  const totals = { input: 0, output: 0, cacheRead: 0 };
  let promptTokenSum = 0;
  let maxPromptTokens = 0;
  let minPromptBytes = Infinity;
  let maxPromptBytes = 0;
  let reReadCount = 0;
  let steps = 0;

  const finish = (status: RunStatus, extra: Partial<RunSummary> = {}): RunSummary => ({
    runId,
    objective,
    status,
    steps,
    totals,
    avgPromptTokens: steps ? Math.round(promptTokenSum / steps) : 0,
    maxPromptTokens,
    minPromptBytes: steps ? minPromptBytes : 0,
    maxPromptBytes,
    reReadCount,
    changedFiles: [...state.changedFiles],
    checks: [...state.checks],
    blockers: [...state.blockers],
    ...extra,
  });

  while (steps < options.maxSteps) {
    if (signal.aborted) return finish("cancelled");
    const step = steps + 1;
    const started = Date.now();
    let retries = 0;
    let errors: string[] | undefined;
    let accepted: { response: StepResponse; next: SkillExecutionState } | undefined;
    let promptBytes = 0;
    let stateBytes = 0;
    let observationBytes = 0;
    const usage = { input: 0, output: 0, cacheRead: 0 };

    // Rollback-retry: every attempt is a fresh (P, Σt, Ot [+ errors]) prompt.
    while (!accepted) {
      const prompt = render(spec, state, observation, errors);
      promptBytes = Buffer.byteLength(prompt);
      stateBytes = Buffer.byteLength(serializeState(state));
      observationBytes = Buffer.byteLength(observation);

      let reply: ModelReply;
      try {
        reply = await complete(prompt, signal);
      } catch (err) {
        if (signal.aborted) return finish("cancelled");
        return finish("failed", { error: "model call failed at step " + step + ": " + String((err as Error).message ?? err) });
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
