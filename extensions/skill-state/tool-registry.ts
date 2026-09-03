import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

// Pi lets an extension list other extensions' tools (pi.getAllTools) but not
// run them. Sibling extensions in this package therefore hand their read-only
// tool definitions to this registry so a state-run can execute them. The
// registry lives on globalThis: Pi may load each extension through its own
// module cache, and a module-level Map would not be shared.

const KEY = Symbol.for("my-pi-agent-plugins.skill-state.tools");

type Registry = Map<string, ToolDefinition<any, any, any>>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

/** Call next to `pi.registerTool(def)` for tools that only read (search, docs, memory, diagnostics). */
export function registerStateRunTool(def: ToolDefinition<any, any, any>): void {
  registry().set(def.name, def);
}

/** Identity wrapper for sibling extensions: `pi.registerTool(stateRunTool({ ... }))`. Read-only tools only. */
export function stateRunTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
  def: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  registerStateRunTool(def as ToolDefinition<any, any, any>);
  return def;
}

export function unregisterStateRunTool(name: string): void {
  registry().delete(name);
}

export interface ToolSpec {
  name: string;
  description: string;
  /** "param (type, required)" fragments, for the prompt vocabulary. */
  params: string[];
}

function schemaType(schema: any): string {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.anyOf)) {
    const literals = schema.anyOf.map((s: any) => s.const).filter((v: unknown) => v !== undefined);
    if (literals.length === schema.anyOf.length) return literals.map((v: unknown) => JSON.stringify(v)).join("|");
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => JSON.stringify(v)).join("|");
  if (schema.type === "array") return schemaType(schema.items) + "[]";
  return typeof schema.type === "string" ? schema.type : "any";
}

/** Compact, prompt-ready view of the registered tools. */
export function listStateRunTools(): ToolSpec[] {
  return [...registry().values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((def) => {
      const props = (def.parameters as any)?.properties ?? {};
      const required = new Set<string>((def.parameters as any)?.required ?? []);
      const params = Object.keys(props).map(
        (k) => k + " (" + schemaType(props[k]) + (required.has(k) ? ", required" : "") + ")",
      );
      const description = String(def.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 160);
      return { name: def.name, description, params };
    });
}

export function validateToolParams(name: string, params: unknown): string[] {
  const def = registry().get(name);
  if (!def) return ["/action/name: no such tool \"" + name + "\"; available: " + [...registry().keys()].join(", ")];
  if (Value.Check(def.parameters, params)) return [];
  return Value.Errors(def.parameters, params).map((e) => "/action/params" + (e.instancePath || "") + ": " + e.message);
}

/** Text content of a tool result, joined; details are not shown to the model. */
export async function runStateRunTool(
  name: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<string> {
  const def = registry().get(name);
  if (!def) throw new Error("no such tool: " + name);
  const result = await def.execute("state-run-" + Date.now().toString(36), params, signal, undefined, ctx);
  const text = (result.content ?? [])
    .map((block: any) => (block.type === "text" ? block.text : "[" + block.type + "]"))
    .join("\n");
  return text;
}

export function hasStateRunTool(name: string): boolean {
  return registry().has(name);
}
