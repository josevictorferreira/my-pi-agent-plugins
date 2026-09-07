import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

// SKILL.state schema (paper §3.1). Runtime-owned fields are never accepted in a
// patch; `additionalProperties: false` on StatePatch turns an attempt into a
// named error path so the retry prompt can point at it.

export const STATUSES = ["inspecting", "planning", "editing", "testing", "repairing"] as const;
export type Status = (typeof STATUSES)[number];

export interface SkillExecutionState {
  // runtime-owned
  version: 1;
  step: number;
  /** Step at which `status` last changed (phase budgets are measured from here). */
  statusSince: number;
  /** Reads, searches and failed writes since the last write that changed a file (exec_shell does not count). */
  readsSinceWrite: number;
  /** Step at which a file last actually changed; 0 when nothing has changed yet. */
  lastWriteStep: number;
  objective: string;
  inspectedFiles: string[];
  changedFiles: string[];
  checks: Array<{ command: string; code: number; summary: string }>;
  // model-owned
  status: Status;
  plan: string[];
  /** Free text: the hypothesis and its current standing, e.g. "open: ..." */
  hypotheses: Record<string, string>;
  facts: Record<string, string>;
  blockers: string[];
}

export const StatePatchSchema = Type.Object(
  {
    status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
    plan: Type.Optional(Type.Array(Type.String())),
    hypotheses: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
    facts: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
    blockers: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type StatePatch = Static<typeof StatePatchSchema>;

const PATCH_KEYS = new Set(Object.keys(StatePatchSchema.properties));
const RUNTIME_OWNED = new Set(["version", "step", "statusSince", "readsSinceWrite", "lastWriteStep", "objective", "inspectedFiles", "changedFiles", "checks"]);

/**
 * Move facts the model put directly under `state_patch` into `state_patch.facts`,
 * in place, and return one notice per moved key. `{"state_patch": {"foo": null}}`
 * for "delete fact foo" was 14 of 24 rejections in one run, each a hard one,
 * and the schema error never said where facts belong. Only string/null values
 * under a key that is neither a patch field nor runtime-owned are moved; the
 * rest still fail validation.
 */
export function relocateStrayFacts(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const patch = (value as Record<string, unknown>).state_patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
  const p = patch as Record<string, unknown>;
  if (p.facts !== undefined && (!p.facts || typeof p.facts !== "object" || Array.isArray(p.facts))) return [];
  const moved: string[] = [];
  for (const [key, v] of Object.entries(p)) {
    if (PATCH_KEYS.has(key) || RUNTIME_OWNED.has(key)) continue;
    if (v !== null && typeof v !== "string") continue;
    const facts = (p.facts ??= {}) as Record<string, unknown>;
    if (!(key in facts)) facts[key] = v;
    delete p[key];
    moved.push(key);
  }
  return moved.length ? ["state_patch." + moved.join(", state_patch.") + " moved into facts: facts belong under state_patch.facts.<key> (null there deletes)."] : [];
}

const strict = { additionalProperties: false } as const;

export const RepoActionSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("search_files"), pattern: Type.String(), glob: Type.Optional(Type.String()) },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("read_file"),
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    strict,
  ),
  Type.Object({ type: Type.Literal("write_file"), path: Type.String(), content: Type.String() }, strict),
  Type.Object(
    { type: Type.Literal("patch_file"), path: Type.String(), oldText: Type.String(), newText: Type.String() },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("exec_shell"),
      command: Type.String(),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    strict,
  ),
  Type.Object({ type: Type.Literal("git_diff"), paths: Type.Optional(Type.Array(Type.String())) }, strict),
  Type.Object(
    { type: Type.Literal("tool"), name: Type.String(), params: Type.Object({}, { additionalProperties: true }) },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("finish"),
      outcome: Type.Union([Type.Literal("completed"), Type.Literal("cannot_complete")]),
      summary: Type.String(),
    },
    strict,
  ),
]);
export type RepoAction = Static<typeof RepoActionSchema>;

export const StepResponseSchema = Type.Object(
  { state_patch: StatePatchSchema, action: RepoActionSchema },
  strict,
);
export type StepResponse = Static<typeof StepResponseSchema>;

export const ACTION_TYPES = ["search_files", "read_file", "write_file", "patch_file", "exec_shell", "git_diff", "tool", "finish"] as const;

// One schema per action type so a known type is validated against its own
// branch and the errors say exactly which field is missing or wrong.
const ACTION_BRANCHES = new Map<string, TSchema>(
  (RepoActionSchema as any).anyOf.map((branch: any) => [branch.properties.type.const as string, branch as TSchema]),
);

function describe(prefix: string, e: { instancePath: string; keyword: string; message: string; params: any }): string {
  const path = prefix + (e.instancePath || "");
  if (e.keyword === "additionalProperties") {
    return path + ": unknown or runtime-owned keys: " + e.params.additionalProperties.join(", ") +
      (path === "/state_patch" ? " (facts belong under /state_patch/facts/<key>)" : "");
  }
  if (path === "/state_patch/status") return path + ": must be one of " + STATUSES.join(", ");
  return path + ": " + e.message;
}

/**
 * Validate a parsed reply. Returns human-readable error lines, empty when
 * valid. Enum-style failures name the allowed values instead of TypeBox's
 * "must be equal to constant", and the action is checked against the schema
 * of its own type so a missing field is reported once.
 */
export function validateStepResponse(value: unknown): string[] {
  if (Value.Check(StepResponseSchema, value)) return [];
  const out: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["/: must be an object with state_patch and action"];
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (key !== "state_patch" && key !== "action") out.push("/: unknown key " + key);
  if (v.state_patch === undefined) out.push("/state_patch: required");
  else for (const e of Value.Errors(StatePatchSchema, v.state_patch)) out.push(describe("/state_patch", e));
  const action = v.action as any;
  if (action === undefined) out.push("/action: required");
  else if (!action || typeof action !== "object") out.push("/action: must be an object");
  else {
    const branch = ACTION_BRANCHES.get(action.type);
    if (!branch) out.push("/action/type: must be one of " + ACTION_TYPES.join(", ") + " (got " + JSON.stringify(action.type) + ")");
    else for (const e of Value.Errors(branch, action)) out.push(describe("/action", e));
  }
  return [...new Set(out)];
}
