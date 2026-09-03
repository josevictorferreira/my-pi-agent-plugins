import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// SKILL.state schema (paper §3.1). Runtime-owned fields are never accepted in a
// patch; `additionalProperties: false` on StatePatch turns an attempt into a
// named error path so the retry prompt can point at it.

export const STATUSES = ["inspecting", "planning", "editing", "testing", "repairing"] as const;
export type Status = (typeof STATUSES)[number];

const HypothesisValue = Type.Union([
  Type.Literal("open"),
  Type.Literal("confirmed"),
  Type.Literal("rejected"),
]);

export interface SkillExecutionState {
  // runtime-owned
  version: 1;
  step: number;
  objective: string;
  inspectedFiles: string[];
  changedFiles: string[];
  checks: Array<{ command: string; code: number; summary: string }>;
  // model-owned
  status: Status;
  plan: string[];
  hypotheses: Record<string, "open" | "confirmed" | "rejected">;
  facts: Record<string, string>;
  blockers: string[];
}

export const StatePatchSchema = Type.Object(
  {
    status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
    plan: Type.Optional(Type.Array(Type.String())),
    hypotheses: Type.Optional(Type.Record(Type.String(), Type.Union([HypothesisValue, Type.Null()]))),
    facts: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
    blockers: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type StatePatch = Static<typeof StatePatchSchema>;

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

/** Validate a parsed reply. Returns human-readable error lines, empty when valid. */
export function validateStepResponse(value: unknown): string[] {
  if (Value.Check(StepResponseSchema, value)) return [];
  return Value.Errors(StepResponseSchema, value).map((e) => {
    const path = e.instancePath || "/";
    if (e.keyword === "additionalProperties") {
      return path + ": unknown or runtime-owned keys: " + e.params.additionalProperties.join(", ");
    }
    return path + ": " + e.message;
  });
}
