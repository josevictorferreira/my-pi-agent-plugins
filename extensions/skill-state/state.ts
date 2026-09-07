import type { SkillExecutionState, StatePatch } from "./schemas";

// Bounds enforced after merge (plan §5.2). Exceeding a count (other than facts)
// or the byte cap fails the patch and leaves Σt untouched (paper §7
// rollback-retry). Over-long values are cut and over-count facts are evicted
// instead, reported in the next observation: models cannot count characters,
// and "value longer than 300 chars" was 14 of 25 rejections in one run,
// killing it once on three consecutive 301-430 char values.
// The cut is marked in the value itself: at 300 chars a run split one 99-char
// source line across six keys and then patched from a fact that had been cut
// mid-token, which a trailing "…" did not warn it about (improvements_3 §7).
// 12 KB / 40 facts: the paper's 6 KB suited shelf and CTF tasks; on source
// code the state grew ~140 B per step and hit 6 KB around step 40, forcing
// fact deletion (the "premature overwrite" failure). Still O(1) per step.
export const MAX_STATE_BYTES = 12 * 1024;
const MAX_FACTS = 40;
const MAX_FACT_KEY_CHARS = 64;
const MAX_FACT_VALUE_CHARS = 600;
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
    lastWriteStep: 0,
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

const CUT_MARKER = " [CUT]";

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + CUT_MARKER : value;
}

/**
 * Merge one string map with null-delete, cutting over-long values and noting
 * each cut. A written key is deleted first so it moves to the end: key order is
 * recency, which is what `evictOldest` relies on.
 */
function mergeMap(target: Record<string, string>, patch: Record<string, string | null>, field: string, max: number, notices: string[]): void {
  for (const [key, value] of Object.entries(patch)) {
    delete target[key];
    if (value !== null) {
      if (value.length > max) {
        notices.push(
          field + "." + key + " was " + value.length + " chars; kept the first " + max + " and marked the value \"" + CUT_MARKER.trim() +
            "\". It is no longer exact text: do not patch from it. Split long notes across keys.",
        );
      }
      target[key] = clip(value, max);
    }
  }
}

/**
 * Over the key cap, drop the oldest keys not written by this patch (then the
 * oldest written ones, if the patch alone is over). Like over-long values this
 * is a notice, not a rejection: at the cap every new fact needed a deletion in
 * the same patch, and one run spent 8 of its last 10 attempts failing that
 * ("41 keys, limit 40" alternating with mis-nested deletes) before it died.
 */
function evictOldest(target: Record<string, string>, written: Set<string>, field: string, max: number, notices: string[]): void {
  const keys = Object.keys(target);
  if (keys.length <= max) return;
  const dropped: string[] = [];
  for (const key of [...keys.filter((k) => !written.has(k)), ...keys.filter((k) => written.has(k))]) {
    if (Object.keys(target).length <= max) break;
    delete target[key];
    dropped.push(key);
  }
  notices.push(
    field + " went over the limit of " + max + " keys; dropped the oldest: " + dropped.join(", ") +
      ". Delete stale keys yourself (\"key\": null) to choose what goes.",
  );
}

/** Σ ⊕ ΔΣ: objects merge shallowly with null-delete, lists are replaced whole. */
function applyPatch(state: SkillExecutionState, patch: StatePatch, notices: string[]): SkillExecutionState {
  const next: SkillExecutionState = structuredClone(state);
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.plan !== undefined) next.plan = [...patch.plan];
  if (patch.blockers !== undefined) next.blockers = [...patch.blockers];
  if (patch.facts) {
    mergeMap(next.facts, patch.facts, "facts", MAX_FACT_VALUE_CHARS, notices);
    evictOldest(next.facts, new Set(Object.keys(patch.facts)), "facts", MAX_FACTS, notices);
  }
  if (patch.hypotheses) mergeMap(next.hypotheses, patch.hypotheses, "hypotheses", MAX_HYPOTHESIS_CHARS, notices);
  return next;
}

function boundErrors(state: SkillExecutionState): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(state.facts)) {
    if (key.length > MAX_FACT_KEY_CHARS) errors.push("/facts/" + key + ": key is " + key.length + " chars, limit " + MAX_FACT_KEY_CHARS);
  }
  const hypothesisKeys = Object.keys(state.hypotheses);
  if (hypothesisKeys.length > MAX_HYPOTHESES) {
    errors.push("/hypotheses: " + hypothesisKeys.length + " keys, limit " + MAX_HYPOTHESES + "; delete settled ones with null");
  }
  if (state.plan.length > MAX_LIST_ITEMS) errors.push("/plan: " + state.plan.length + " items, limit " + MAX_LIST_ITEMS);
  if (state.blockers.length > MAX_LIST_ITEMS) errors.push("/blockers: " + state.blockers.length + " items, limit " + MAX_LIST_ITEMS);
  const bytes = Buffer.byteLength(serializeState(state));
  if (bytes > MAX_STATE_BYTES) {
    errors.push("state is " + bytes + " bytes, limit " + MAX_STATE_BYTES + "; delete or shorten facts");
  }
  return errors;
}

/** `notices` are runtime adjustments the model must hear about (cut values); shown in the next observation. */
export type MergeResult = { ok: true; state: SkillExecutionState; notices: string[] } | { ok: false; errors: string[] };

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
/** In `editing`, actions that changed nothing allowed between two writes. */
export const READS_BEFORE_EDIT = 3;
/**
 * Steps `editing` may run without a file actually changing. `inspecting` and
 * `planning` are budgeted; `editing` was not, and one run spent 138 consecutive
 * steps there re-sending a patch that could not apply (improvements_3 §4).
 */
export const EDIT_STALL_STEPS = 12;

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
  if (patch.plan) {
    patch.plan.forEach((item, i) => {
      if (!isConcretePlanItem(item)) {
        errors.push("/plan/" + i + ": name the file to change (a path) or the command to run; \"" + item.slice(0, 60) + "\" is neither");
      }
    });
  }
  return errors;
}

// A plan item is concrete when it names a path (contains "/" or file.ext) or a
// command to run. "Search for X" or "Investigate Y" is more inspection, not a plan.
const PATH_LIKE = /(^|[\s"'`(])[\w@.~-]*\/[\w@./~-]+|\b[\w-]+\.[a-z][a-z0-9]{0,5}\b/i;
const LEADING_VERB = /^(run|execute|test|verify|check|exec_shell)\b/i;
const COMMAND_TOKEN = /\b(exec_shell|bundle|npm|bun|pnpm|yarn|npx|rspec|pytest|jest|vitest|cargo|go test|make|rails|rake|git|mix|dotnet|mvn|gradle|tsc|eslint|rubocop)\b/i;
export function isConcretePlanItem(item: string): boolean {
  const t = item.trim();
  return PATH_LIKE.test(t) || LEADING_VERB.test(t) || COMMAND_TOKEN.test(t) || t.includes("`");
}

// Actions that advance the read streak in `editing`. `exec_shell` is not one:
// running the checks after an edit is what the phase is for, and counting it
// made read → read → rspec trip the gate on a run that then wanted to re-read
// the one file its next edit needed.
const STREAK_ACTIONS = new Set(["read_file", "search_files", "git_diff", "tool"]);
const WRITE_ACTIONS = new Set(["write_file", "patch_file"]);

/**
 * Action policy for the step being decided: in `editing`, after
 * READS_BEFORE_EDIT actions that changed nothing the next action must be an
 * edit or finish, and after EDIT_STALL_STEPS steps with no file changed the
 * phase itself has to end. Facts hold what was learned; re-reading is not
 * progress, and neither is a patch that keeps being rejected. One exception:
 * at the gate, a single read_file of the file the first plan item names is
 * allowed, because the model cannot see the observation it read it in and
 * "use the text you already read" asks for something it no longer has.
 */
export function actionErrors(next: SkillExecutionState, action: { type: string; path?: string }): string[] {
  const actionType = action.type;
  if (actionType === "finish") return [];
  // `testing` is the one phase whose steps are meant to change nothing.
  const stalled = next.step + 1 - Math.max(next.statusSince, next.lastWriteStep) - 1;
  if ((next.status === "editing" || next.status === "repairing") && stalled >= EDIT_STALL_STEPS) {
    return [
      "/status: " + stalled + " steps in \"" + next.status + "\" and no file has changed" +
        (next.lastWriteStep ? " since step " + next.lastWriteStep : " at all") +
        ". Repeating the same edit will not start working. Record in facts what the failed attempts have in common, then change status to a " +
        "different phase (\"repairing\" to diagnose the failure, \"testing\" if the change is already in place) or send finish with what remains.",
    ];
  }
  if (next.status !== "editing") return [];
  if (next.readsSinceWrite < READS_BEFORE_EDIT || WRITE_ACTIONS.has(actionType)) return [];
  if (actionType === "read_file" && next.readsSinceWrite === READS_BEFORE_EDIT && action.path && next.plan[0]?.includes(action.path)) return [];
  return [
    "/action: " + next.readsSinceWrite + " actions since the last file change while in \"editing\" " +
      "(reads, searches, git_diff and rejected writes count; exec_shell does not). " +
      "The next action must be write_file or patch_file applying the first plan item, or finish. " +
      "If you no longer have the exact text, patch_file on a short fragment you are certain of (a class or def line) is enough.",
  ];
}

/**
 * Track progress for the action policy. Only an action that actually changed a
 * file counts as a write: a rejected patch_file used to reset the read streak,
 * so `read_file → failed patch_file → …` disabled the only loop guard there is
 * (it fired once in 346 steps; improvements_3 §3).
 */
export function recordAction(state: SkillExecutionState, actionType: string, changed: boolean): void {
  if (changed) {
    state.readsSinceWrite = 0;
    state.lastWriteStep = state.step;
  } else if (STREAK_ACTIONS.has(actionType) || WRITE_ACTIONS.has(actionType)) {
    state.readsSinceWrite++;
  }
}

/** Atomic merge: validate → clone → merge → bound-check → commit or reject. */
export function merge(state: SkillExecutionState, patch: StatePatch, policy?: PhasePolicy): MergeResult {
  const notices: string[] = [];
  const next = applyPatch(state, patch, notices);
  if (next.status !== state.status) {
    // Phase bookkeeping is runtime-owned and must be in place before the
    // policies below look at it: the step being decided is state.step + 1, and
    // the read streak limit is "between edits while editing", so inspection
    // reads do not count.
    next.statusSince = state.step + 1;
    if (next.status === "editing") next.readsSinceWrite = 0;
  }
  const errors = boundErrors(next);
  if (policy) errors.push(...phaseErrors(state, next, patch, policy));
  return errors.length ? { ok: false, errors } : { ok: true, state: next, notices };
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
