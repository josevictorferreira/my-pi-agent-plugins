import type { SkillExecutionState, StatePatch } from "./schemas";

// Bounds enforced after merge (plan §5.2). Exceeding any of them fails the
// patch and leaves Σt untouched (paper §7 rollback-retry).
export const MAX_STATE_BYTES = 6 * 1024;
const MAX_FACTS = 24;
const MAX_FACT_KEY_CHARS = 64;
const MAX_FACT_VALUE_CHARS = 300;
const MAX_HYPOTHESES = 12;
const MAX_HYPOTHESIS_CHARS = 200;
const MAX_LIST_ITEMS = 15;
const MAX_CHECKS = 5;
const MAX_FILE_ENTRIES = 40;

export function createInitialState(objective: string): SkillExecutionState {
  return {
    version: 1,
    step: 0,
    statusSince: 0,
    readsSinceWrite: 0,
    objective,
    inspectedFiles: [],
    changedFiles: [],
    checks: [],
    status: "inspecting",
    plan: [],
    hypotheses: {},
    facts: {},
    blockers: [],
  };
}

export function serializeState(state: SkillExecutionState): string {
  return JSON.stringify(state);
}

/** Σ ⊕ ΔΣ: objects merge shallowly with null-delete, lists are replaced whole. */
function applyPatch(state: SkillExecutionState, patch: StatePatch): SkillExecutionState {
  const next: SkillExecutionState = structuredClone(state);
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.plan !== undefined) next.plan = [...patch.plan];
  if (patch.blockers !== undefined) next.blockers = [...patch.blockers];
  if (patch.facts) {
    for (const [key, value] of Object.entries(patch.facts)) {
      if (value === null) delete next.facts[key];
      else next.facts[key] = value;
    }
  }
  if (patch.hypotheses) {
    for (const [key, value] of Object.entries(patch.hypotheses)) {
      if (value === null) delete next.hypotheses[key];
      else next.hypotheses[key] = value;
    }
  }
  return next;
}

function boundErrors(state: SkillExecutionState): string[] {
  const errors: string[] = [];
  const factKeys = Object.keys(state.facts);
  if (factKeys.length > MAX_FACTS) errors.push("/facts: more than " + MAX_FACTS + " keys");
  for (const key of factKeys) {
    if (key.length > MAX_FACT_KEY_CHARS) errors.push("/facts/" + key + ": key longer than " + MAX_FACT_KEY_CHARS);
    if (state.facts[key].length > MAX_FACT_VALUE_CHARS) {
      errors.push("/facts/" + key + ": value longer than " + MAX_FACT_VALUE_CHARS + " chars");
    }
  }
  const hypothesisKeys = Object.keys(state.hypotheses);
  if (hypothesisKeys.length > MAX_HYPOTHESES) errors.push("/hypotheses: more than " + MAX_HYPOTHESES + " keys");
  for (const key of hypothesisKeys) {
    if (state.hypotheses[key].length > MAX_HYPOTHESIS_CHARS) {
      errors.push("/hypotheses/" + key + ": value longer than " + MAX_HYPOTHESIS_CHARS + " chars");
    }
  }
  if (state.plan.length > MAX_LIST_ITEMS) errors.push("/plan: more than " + MAX_LIST_ITEMS + " items");
  if (state.blockers.length > MAX_LIST_ITEMS) errors.push("/blockers: more than " + MAX_LIST_ITEMS + " items");
  const bytes = Buffer.byteLength(serializeState(state));
  if (bytes > MAX_STATE_BYTES) {
    errors.push("state is " + bytes + " bytes, limit " + MAX_STATE_BYTES + "; delete or shorten facts");
  }
  return errors;
}

export type MergeResult = { ok: true; state: SkillExecutionState } | { ok: false; errors: string[] };

/**
 * Phase policy, enforced like any other state bound. Prose rules in the spec
 * are not reliably followed; validation errors are, because rollback-retry
 * re-asks with the error attached.
 */
export interface PhasePolicy {
  /** Total step budget of the run. */
  maxSteps: number;
}

/** Inspection never needs more than this many steps, whatever the run budget. */
export const MAX_INSPECT_STEPS = 30;

/** Steps the run may spend in `inspecting` before a plan is required. */
export function inspectBudget(maxSteps: number): number {
  return Math.min(MAX_INSPECT_STEPS, Math.max(2, Math.ceil(maxSteps / 3)));
}

/** `planning` is where the plan gets written; after this many steps the run must edit. */
export const PLANNING_STEPS = 2;
/** In `editing`, read-only actions allowed between two writes. */
export const READS_BEFORE_EDIT = 3;

function phaseErrors(prev: SkillExecutionState, next: SkillExecutionState, patch: StatePatch, policy: PhasePolicy): string[] {
  const errors: string[] = [];
  const stepBeingDecided = next.step + 1;
  const budget = inspectBudget(policy.maxSteps);
  const since = next.status === prev.status ? prev.statusSince : stepBeingDecided;
  if (next.status === "planning" && stepBeingDecided - since >= PLANNING_STEPS) {
    errors.push(
      "/status: planning has used its " + PLANNING_STEPS + " steps. Set status to \"editing\" and start applying the first plan item; " +
        "read files only to get exact text for patch_file. Missing pieces the objective asks for are yours to create, not to search for.",
    );
  }
  if (next.status === "inspecting" && stepBeingDecided > budget) {
    errors.push(
      "/status: inspection budget of " + budget + " steps is spent (this is step " + stepBeingDecided +
        "). Set status to \"planning\" and send a plan of concrete edits from the facts you have; record unknowns as hypotheses.",
    );
  }
  if (patch.status === "planning" && next.plan.length === 0) {
    errors.push('/plan: entering "planning" requires a non-empty plan (ordered concrete edits, each with the check that proves it).');
  }
  if (patch.status === "editing" && prev.status !== "editing" && next.plan.length === 0 && prev.status !== "repairing") {
    errors.push('/plan: entering "editing" requires a plan; write it first.');
  }
  if (patch.status === "testing" && prev.status !== "testing" && next.changedFiles.length === 0) {
    errors.push('/status: "testing" requires at least one changed file; nothing has been edited yet. Stay in "editing" and apply the first plan item.');
  }
  return errors;
}

const READ_ONLY_ACTIONS = new Set(["read_file", "search_files", "exec_shell", "git_diff"]);
const WRITE_ACTIONS = new Set(["write_file", "patch_file"]);

/**
 * Action policy for the step being decided: in `editing`, after
 * READS_BEFORE_EDIT read-only actions without a write, the next action must be
 * an edit or finish. Facts hold what was learned; re-reading is not progress.
 */
export function actionErrors(next: SkillExecutionState, actionType: string): string[] {
  if (next.status !== "editing") return [];
  if (next.readsSinceWrite < READS_BEFORE_EDIT || WRITE_ACTIONS.has(actionType) || actionType === "finish") return [];
  return [
    "/action: " + next.readsSinceWrite + " read-only actions since the last edit while in \"editing\". " +
      "The next action must be write_file or patch_file applying the first plan item (use the exact text you already read), or finish.",
  ];
}

/** Track read-only vs write actions for the action policy. */
export function recordAction(state: SkillExecutionState, actionType: string): void {
  if (WRITE_ACTIONS.has(actionType)) state.readsSinceWrite = 0;
  else if (READ_ONLY_ACTIONS.has(actionType)) state.readsSinceWrite++;
}

/** Atomic merge: validate → clone → merge → bound-check → commit or reject. */
export function merge(state: SkillExecutionState, patch: StatePatch, policy?: PhasePolicy): MergeResult {
  const next = applyPatch(state, patch);
  const errors = boundErrors(next);
  if (policy) errors.push(...phaseErrors(state, next, patch, policy));
  return errors.length ? { ok: false, errors } : { ok: true, state: next };
}

// Runtime-owned fields, mutated in place by the runner after each action.

function pushUnique(list: string[], item: string): void {
  const index = list.indexOf(item);
  if (index !== -1) list.splice(index, 1);
  list.push(item);
  while (list.length > MAX_FILE_ENTRIES) list.shift();
}

export function recordInspected(state: SkillExecutionState, path: string): void {
  pushUnique(state.inspectedFiles, path);
}

export function recordChanged(state: SkillExecutionState, path: string): void {
  pushUnique(state.changedFiles, path);
}

export function recordCheck(state: SkillExecutionState, check: SkillExecutionState["checks"][number]): void {
  state.checks.push(check);
  while (state.checks.length > MAX_CHECKS) state.checks.shift();
}
