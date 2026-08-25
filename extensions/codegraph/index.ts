import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Where oh-my-openagent provisions the CLI, checked last so a PATH install wins.
const OMO_FALLBACK_BIN = join(homedir(), ".omo", "codegraph", "bin", "codegraph");

// Upstream's own measurement: one strong tool steers agents better than a menu
// of narrow ones, and everything the narrow tools return already arrives inline
// on explore. The rest stay one env var away.
const DEFAULT_TOOLS = "explore,node";
const ALL_TOOLS = ["explore", "node", "query", "callers", "callees", "impact", "files", "status"];

const DEFAULT_TIMEOUT_MS = 120000;
// A broad explore on a large repo emits a lot of verbatim source.
const MAX_BUFFER = 10 * 1024 * 1024;

// codegraph ignores NO_COLOR; every command except explore/node colors stdout,
// and all of them color stderr.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// An unindexed project exits 1 with guidance aimed at the agent ("continue with
// your usual tools; indexing is the user's decision"). That is an answer, not a
// failure, so it is relayed as a normal result and the model falls back.
const NOT_INDEXED_PATTERN =
  /CodeGraph (?:isn't available here|not initialized)|isn't indexed with codegraph|No CodeGraph project is loaded/i;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

let cachedBin: string | null | undefined;

/** CODEGRAPH_BIN -> PATH -> the OMO-provisioned path. Null when unresolvable. */
function resolveBin(): string | null {
  if (cachedBin === undefined) cachedBin = findBin();
  return cachedBin;
}

function findBin(): string | null {
  const override = process.env.CODEGRAPH_BIN;
  if (override && existsSync(override)) return override;

  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["codegraph"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    })
      .split("\n")[0]
      ?.trim();
    if (found) return found;
  } catch {
    // Not on PATH.
  }

  return existsSync(OMO_FALLBACK_BIN) ? OMO_FALLBACK_BIN : null;
}

/**
 * Nearest ancestor holding a `.codegraph/` index, the way git finds `.git/`.
 * `existsSync` follows symlinks on purpose — an OMO-managed project links
 * `.codegraph` into `~/.omo/codegraph/projects/`.
 */
function findIndexedRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".codegraph"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function enabledTools(): Set<string> {
  const configured = (process.env.CODEGRAPH_TOOLS || DEFAULT_TOOLS)
    .split(",")
    .map((name) => name.trim().replace(/^codegraph_/, ""))
    .filter((name) => ALL_TOOLS.includes(name));
  return new Set(configured);
}

/** Run a codegraph subcommand and return its model-ready output. */
async function runCodegraph(
  tool: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ data?: string; error?: string }> {
  const bin = resolveBin();
  if (!bin) return { error: tool + ": the codegraph CLI could not be found." };

  const timeout = Number(process.env.CODEGRAPH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      encoding: "utf-8",
      signal,
    });
    const out = stdout.trim();
    return { data: out || stripAnsi(stderr).trim() };
  } catch (err: any) {
    if (signal?.aborted) return { error: tool + " was cancelled." };
    if (err?.killed) return { error: tool + " timed out after " + timeout + "ms." };
    const detail = stripAnsi(String(err?.stderr || err?.stdout || err?.message || err)).trim();
    if (NOT_INDEXED_PATTERN.test(detail)) return { data: detail };
    return { error: tool + " failed: " + detail };
  }
}

function pathArgs(projectPath: string | undefined): string[] {
  return projectPath ? ["-p", projectPath] : [];
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

const PROJECT_PATH_PARAM = Type.Optional(
  Type.String({
    description:
      "Absolute path of another indexed project to query (a monorepo sub-service, or a " +
      "second repo). Defaults to the current project.",
  }),
);

export default function (pi: ExtensionAPI) {
  let registered = false;

  // Registered on session_start rather than at load: ctx.cwd is only available
  // here, and tools that can only answer "not indexed" are not worth their
  // system-prompt budget. A /resume into an indexed project registers then.
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (registered) return;
    if (!resolveBin()) return;
    if (!findIndexedRoot(ctx.cwd)) return;
    registered = true;

    const enabled = enabledTools();

    if (enabled.has("explore")) {
      pi.registerTool({
        name: "codegraph_explore",
        label: "Explore Code",
        description:
          "Answer a question about this codebase in one call. Returns the relevant symbols' " +
          "verbatim, line-numbered source grouped by file, the call paths between them, and a " +
          "blast-radius summary of what depends on them. Follows dynamic dispatch (callbacks, " +
          "interface-to-implementation, framework re-render) that grep cannot. Naming a file or " +
          "symbol in the query returns its current source, the same shape the read tool gives you.",
        promptSnippet:
          "Semantic codebase search: symbols' source, call paths and blast radius in one call",
        promptGuidelines: [
          "Start every codebase investigation ('how does X work', 'what would break if I " +
            "change X') with codegraph_explore, never with grep/rg or reading files; do not " +
            "re-read files whose source codegraph_explore already returned.",
          "If codegraph_explore reports a missing or stale index, fall back to grep and read " +
            "instead of retrying.",
        ],
        parameters: Type.Object({
          query: Type.String({
            minLength: 1,
            description:
              "A natural language question, or a bag of symbol names spanning the flow you are " +
              'investigating (e.g. "OrderController submit OrderService placeOrder"). Naming the ' +
              "class alongside an ambiguous method name disambiguates it.",
          }),
          max_files: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 50,
              description: "Maximum number of files to include source from.",
            }),
          ),
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          const args = ["explore", params.query, ...pathArgs(params.project_path)];
          if (params.max_files !== undefined) args.push("--max-files", String(params.max_files));

          const { data, error } = await runCodegraph("codegraph_explore", args, ctx.cwd, signal);
          if (error) return errorResult(error);
          // explore emits clean markdown, already formatted for a model.
          return textResult(data!, { query: params.query, projectPath: params.project_path });
        },
      });
    }

    if (enabled.has("node")) {
      pi.registerTool({
        name: "codegraph_node",
        label: "Read Symbol",
        description:
          "Read one symbol's source plus its caller/callee trail, or read a file with line " +
          "numbers and its dependents. Container symbols (classes, interfaces, structs, enums, " +
          "modules, namespaces) return a structural outline with a member list by design — for a " +
          "container's code, call codegraph_node on a specific member, or pass `file` for file mode.",
        promptSnippet: "Read one symbol's source with its callers/callees, or a file with dependents",
        promptGuidelines: [
          "Use codegraph_node to read one symbol's source and its callers instead of reading a " +
            "whole file.",
        ],
        parameters: Type.Object({
          name: Type.String({
            minLength: 1,
            description: "Symbol name, or a file path when reading in file mode.",
          }),
          file: Type.Optional(
            Type.String({
              description:
                "Treat `name` as a file path, or disambiguate a symbol to this file.",
            }),
          ),
          offset: Type.Optional(
            Type.Integer({ minimum: 1, description: "File mode: 1-based start line." }),
          ),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, description: "File mode: maximum lines to return." }),
          ),
          symbols_only: Type.Optional(
            Type.Boolean({
              description: "File mode: return just the symbol map and dependents, no source.",
            }),
          ),
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          const args = ["node", params.name, ...pathArgs(params.project_path)];
          if (params.file !== undefined) args.push("-f", params.file);
          if (params.offset !== undefined) args.push("--offset", String(params.offset));
          if (params.limit !== undefined) args.push("--limit", String(params.limit));
          if (params.symbols_only) args.push("--symbols-only");

          const { data, error } = await runCodegraph("codegraph_node", args, ctx.cwd, signal);
          if (error) return errorResult(error);
          // node emits clean markdown, same as explore.
          return textResult(data!, { name: params.name, projectPath: params.project_path });
        },
      });
    }

    if (enabled.has("query")) {
      pi.registerTool({
        name: "codegraph_query",
        label: "Search Symbols",
        description:
          "Search the index for symbols by name and return their kind and location. " +
          "Use codegraph_explore instead when you want to understand code rather than locate it.",
        promptSnippet: "Locate symbols by name or fragment in the code index",
        parameters: Type.Object({
          search: Type.String({ minLength: 1, description: "Symbol name or fragment." }),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results (default 10)." }),
          ),
          kind: Type.Optional(
            Type.String({ description: 'Filter by node kind, e.g. "function", "class", "method".' }),
          ),
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          const args = ["query", params.search, ...pathArgs(params.project_path)];
          if (params.limit !== undefined) args.push("-l", String(params.limit));
          if (params.kind !== undefined) args.push("-k", params.kind);

          const { data, error } = await runCodegraph("codegraph_query", args, ctx.cwd, signal);
          if (error) return errorResult(error);
          return textResult(stripAnsi(data!), { search: params.search });
        },
      });
    }

    for (const direction of ["callers", "callees"] as const) {
      if (!enabled.has(direction)) continue;
      pi.registerTool({
        name: "codegraph_" + direction,
        label: direction === "callers" ? "Find Callers" : "Find Callees",
        description:
          direction === "callers"
            ? "Find every function or method that calls a symbol. Zero callers outside tests is " +
              "strong evidence a symbol is dead code."
            : "Find every function or method that a symbol calls.",
        promptSnippet:
          direction === "callers"
            ? "List every caller of a symbol"
            : "List every symbol a function or method calls",
        parameters: Type.Object({
          symbol: Type.String({ minLength: 1, description: "Symbol name to trace." }),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 200, description: "Maximum results (default 20)." }),
          ),
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          const args = [direction, params.symbol, ...pathArgs(params.project_path)];
          if (params.limit !== undefined) args.push("-l", String(params.limit));

          const { data, error } = await runCodegraph(
            "codegraph_" + direction,
            args,
            ctx.cwd,
            signal,
          );
          if (error) return errorResult(error);
          return textResult(stripAnsi(data!), { symbol: params.symbol });
        },
      });
    }

    if (enabled.has("impact")) {
      pi.registerTool({
        name: "codegraph_impact",
        label: "Analyze Impact",
        description:
          "Analyze what code is affected by changing a symbol, traversing dependents to a given " +
          "depth. Use before editing a widely-used symbol.",
        promptSnippet: "Blast radius of changing a symbol, to a given depth",
        promptGuidelines: [
          "Use codegraph_impact before editing a symbol that is used from many places.",
        ],
        parameters: Type.Object({
          symbol: Type.String({ minLength: 1, description: "Symbol about to change." }),
          depth: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 10, description: "Traversal depth (default 2)." }),
          ),
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          const args = ["impact", params.symbol, ...pathArgs(params.project_path)];
          if (params.depth !== undefined) args.push("-d", String(params.depth));

          const { data, error } = await runCodegraph("codegraph_impact", args, ctx.cwd, signal);
          if (error) return errorResult(error);
          return textResult(stripAnsi(data!), { symbol: params.symbol });
        },
      });
    }

    if (enabled.has("files")) {
      pi.registerTool({
        name: "codegraph_files",
        label: "List Indexed Files",
        description:
          "Show the project's file structure from the index, with each file's language and " +
          "symbol count.",
        promptSnippet: "Indexed file tree with language and symbol counts",
        parameters: Type.Object({
          filter: Type.Optional(
            Type.String({ description: "Only files under this directory." }),
          ),
          pattern: Type.Optional(Type.String({ description: "Only files matching this glob." })),
          format: Type.Optional(
            Type.String({ description: '"tree" (default), "flat", or "grouped".' }),
          ),
          max_depth: Type.Optional(
            Type.Integer({ minimum: 1, description: "Maximum depth for tree format." }),
          ),
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          const args = ["files", ...pathArgs(params.project_path)];
          if (params.filter !== undefined) args.push("--filter", params.filter);
          if (params.pattern !== undefined) args.push("--pattern", params.pattern);
          if (params.format !== undefined) args.push("--format", params.format);
          if (params.max_depth !== undefined) args.push("--max-depth", String(params.max_depth));

          const { data, error } = await runCodegraph("codegraph_files", args, ctx.cwd, signal);
          if (error) return errorResult(error);
          return textResult(stripAnsi(data!), { filter: params.filter });
        },
      });
    }

    if (enabled.has("status")) {
      pi.registerTool({
        name: "codegraph_status",
        label: "CodeGraph Status",
        description:
          "Show the index status and statistics for a project: file, node and edge counts, and " +
          "a breakdown by symbol kind.",
        promptSnippet: "Code index status and statistics",
        parameters: Type.Object({
          project_path: PROJECT_PATH_PARAM,
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
          // status takes the project as a positional argument, not -p.
          const args = params.project_path ? ["status", params.project_path] : ["status"];

          const { data, error } = await runCodegraph("codegraph_status", args, ctx.cwd, signal);
          if (error) return errorResult(error);
          return textResult(stripAnsi(data!), { projectPath: params.project_path });
        },
      });
    }
  });
}
