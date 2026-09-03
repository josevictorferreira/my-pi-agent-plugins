import type { SkillExecutionState, StatePatch } from "./schemas";

// Bounds enforced after merge (plan §5.2). Exceeding any of them fails the
// patch and leaves Σt untouched (paper §7 rollback-retry).
export const MAX_STATE_BYTES = 6 * 1024;
const MAX_FACTS = 24;
const MAX_FACT_KEY_CHARS = 64;
const MAX_FACT_VALUE_CHARS = 300;
const MAX_HYPOTHESES = 12;
const MAX_LIST_ITEMS = 15;
const MAX_CHECKS = 5;
const MAX_FILE_ENTRIES = 40;

export function createInitialState(objective: string): SkillExecutionState {
  return {
    version: 1,
    step: 0,
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
  if (Object.keys(state.hypotheses).length > MAX_HYPOTHESES) {
    errors.push("/hypotheses: more than " + MAX_HYPOTHESES + " keys");
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

/** Atomic merge: validate → clone → merge → bound-check → commit or reject. */
export function merge(state: SkillExecutionState, patch: StatePatch): MergeResult {
  const next = applyPatch(state, patch);
  const errors = boundErrors(next);
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
