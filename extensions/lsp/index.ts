import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolResultEvent,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { type Diagnostic, LspClient, fileUri } from "./client";
import { type LspServerConfig, findRoot, isDisabledByEnv, loadConfig } from "./servers";

/** opencode's cap: enough to act on, not enough to flood the context window. */
const MAX_DIAGNOSTICS_PER_FILE = 20;
const SEVERITY_ERROR = 1;

const POSITIONAL_OPERATIONS = ["hover", "goToDefinition", "findReferences"];

function clientKey(root: string, serverId: string): string {
  return root + "\0" + serverId;
}

const pathLookup = new Map<string, boolean>();

/** Cheap `which`: a server whose binary is absent is skipped, never spawned. */
function commandExists(command: string): boolean {
  const cached = pathLookup.get(command);
  if (cached !== undefined) return cached;

  let found: boolean;
  if (command.includes("/")) {
    found = existsSync(command);
  } else {
    const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    found = dirs.some((dir) => existsSync(join(dir, command)));
  }
  pathLookup.set(command, found);
  return found;
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  const line = diagnostic.range.start.line + 1;
  const column = diagnostic.range.start.character + 1;
  const source = diagnostic.source ? " (" + diagnostic.source + ")" : "";
  return "ERROR [" + line + ":" + column + "] " + diagnostic.message + source;
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  if (isDisabledByEnv()) return;

  const clients = new Map<string, LspClient>();
  // Concurrent edits of the same file must not race two processes into life.
  const starting = new Map<string, Promise<LspClient | null>>();
  // Spawn or initialize failed once — never retried for this session.
  const broken = new Set<string>();
  const missingBinaries = new Set<string>();

  let config: LspServerConfig[] | undefined;

  function servers(ctx: ExtensionContext): LspServerConfig[] {
    if (config) return config;
    const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    for (const error of loaded.errors) {
      ctx.ui.notify("lsp config: " + error, "warning");
    }
    config = loaded.servers;
    return config;
  }

  async function startClient(
    server: LspServerConfig,
    root: string,
    key: string,
  ): Promise<LspClient | null> {
    if (!commandExists(server.command[0]!)) {
      missingBinaries.add(server.id);
      broken.add(key);
      return null;
    }
    try {
      const client = await LspClient.start(server, root);
      clients.set(key, client);
      return client;
    } catch {
      broken.add(key);
      return null;
    }
  }

  /** Live clients for a file, spawning them lazily. Never throws. */
  async function clientsFor(absolutePath: string, ctx: ExtensionContext): Promise<LspClient[]> {
    const ext = extname(absolutePath).toLowerCase();
    if (!ext) return [];

    const result: LspClient[] = [];
    for (const server of servers(ctx)) {
      if (!server.extensions.includes(ext)) continue;

      const root = findRoot(absolutePath, ctx.cwd, server.rootMarkers);
      const key = clientKey(root, server.id);
      if (broken.has(key)) continue;

      const existing = clients.get(key);
      if (existing?.isAlive) {
        result.push(existing);
        continue;
      }
      if (existing) {
        // Died mid-session; opencode does not restart either.
        clients.delete(key);
        broken.add(key);
        continue;
      }

      let pending = starting.get(key);
      if (!pending) {
        pending = startClient(server, root, key).finally(() => starting.delete(key));
        starting.set(key, pending);
      }
      const client = await pending;
      if (client) result.push(client);
    }
    return result;
  }

  function resolvePath(filePath: string, ctx: ExtensionContext): string {
    return isAbsolute(filePath) ? filePath : resolve(ctx.cwd, filePath);
  }

  // --- Auto-diagnostics after edit/write ------------------------------------

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    if (event.isError) return;

    const inputPath = event.input.path;
    if (typeof inputPath !== "string" || inputPath.length === 0) return;

    const absolutePath = resolvePath(inputPath, ctx);
    let diagnostics: Diagnostic[];
    try {
      const targets = await clientsFor(absolutePath, ctx);
      if (targets.length === 0) return;

      const uri = fileUri(absolutePath);
      diagnostics = (
        await Promise.all(
          targets.map(async (client) => {
            await client.touchFile(absolutePath);
            return client.waitForDiagnostics(uri);
          }),
        )
      ).flat();
    } catch {
      // Diagnostics are a bonus; a broken server must not fail the edit.
      return;
    }

    const errors = diagnostics.filter((d) => d.severity === SEVERITY_ERROR);
    if (errors.length === 0) return;

    const shown = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE).map(formatDiagnostic);
    if (errors.length > shown.length) {
      shown.push("... and " + (errors.length - shown.length) + " more");
    }

    const displayPath = relative(ctx.cwd, absolutePath) || absolutePath;
    const text =
      "LSP errors detected in this file, please fix:\n" +
      '<diagnostics file="' + displayPath + '">\n' +
      shown.join("\n") +
      "\n</diagnostics>";

    return { content: [...event.content, { type: "text" as const, text }] };
  });

  // --- lsp tool -------------------------------------------------------------

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description:
      "Query a language server about the code: hover types and docs, jump to a " +
      "definition, list references, list symbols in a file or across the " +
      "workspace, or read the current diagnostics of a file. Positions are " +
      "1-based, matching what read shows.",
    promptSnippet:
      "Language-server lookups: hover, definition, references, symbols, diagnostics",
    promptGuidelines: [
      "Once you have a symbol's file and line, use lsp (definition, references, " +
        "hover) instead of grep to follow it or check its type; lsp resolves " +
        "imports, overloads and re-exports that text search cannot.",
      "Do not call lsp diagnostics for a file you just edited or wrote: its errors " +
        "are already appended to the edit/write result.",
    ],
    parameters: Type.Object({
      operation: Type.Union(
        [
          Type.Literal("hover"),
          Type.Literal("goToDefinition"),
          Type.Literal("findReferences"),
          Type.Literal("documentSymbol"),
          Type.Literal("workspaceSymbol"),
          Type.Literal("diagnostics"),
        ],
        {
          description:
            "hover, goToDefinition and findReferences need line and column; " +
            "workspaceSymbol needs query.",
        },
      ),
      filePath: Type.String({
        minLength: 1,
        description:
          "File to query, absolute or relative to the project root. Also selects " +
          "which language server answers.",
      }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line number." })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column number." })),
      query: Type.Optional(Type.String({ description: "Search string for workspaceSymbol." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const absolutePath = resolvePath(params.filePath, ctx);
      const ext = extname(absolutePath).toLowerCase();

      if (POSITIONAL_OPERATIONS.includes(params.operation)) {
        if (params.line === undefined || params.column === undefined) {
          return errorResult(params.operation + " requires both line and column (1-based).");
        }
      }
      if (params.operation === "workspaceSymbol" && !params.query) {
        return errorResult("workspaceSymbol requires query.");
      }

      let targets: LspClient[];
      try {
        targets = await clientsFor(absolutePath, ctx);
      } catch {
        targets = [];
      }
      if (targets.length === 0) {
        const configured = servers(ctx).some((s) => s.extensions.includes(ext));
        return errorResult(
          configured
            ? "No LSP server is running for " + ext + " files (not on PATH, or it failed to start). Run /lsp for details."
            : "No LSP server configured for " + ext + " files.",
        );
      }

      const uri = fileUri(absolutePath);
      const position = {
        line: (params.line ?? 1) - 1,
        character: (params.column ?? 1) - 1,
      };

      const answers = await Promise.all(
        targets.map(async (client) => {
          try {
            await client.touchFile(absolutePath);
            switch (params.operation) {
              case "hover":
                return await client.request("textDocument/hover", {
                  textDocument: { uri },
                  position,
                });
              case "goToDefinition":
                return await client.request("textDocument/definition", {
                  textDocument: { uri },
                  position,
                });
              case "findReferences":
                return await client.request("textDocument/references", {
                  textDocument: { uri },
                  position,
                  context: { includeDeclaration: true },
                });
              case "documentSymbol":
                return await client.request("textDocument/documentSymbol", {
                  textDocument: { uri },
                });
              case "workspaceSymbol":
                return await client.request("workspace/symbol", { query: params.query });
              case "diagnostics":
                await client.waitForDiagnostics(uri);
                return client.getDiagnostics(uri);
            }
          } catch (err) {
            return { error: String(err) };
          }
        }),
      );

      const payload =
        answers.length === 1
          ? answers[0]
          : targets.map((client, index) => ({ server: client.id, result: answers[index] }));

      const empty =
        payload === null ||
        payload === undefined ||
        (Array.isArray(payload) && payload.length === 0);

      return {
        content: [
          {
            type: "text" as const,
            text: empty
              ? "No results for " + params.operation + "."
              : JSON.stringify(payload, null, 2),
          },
        ],
        details: { operation: params.operation, servers: targets.map((c) => c.id) },
      };
    },
  });

  // --- /lsp status ----------------------------------------------------------

  pi.registerCommand("lsp", {
    description: "Show language server status",
    handler: async (_args, ctx) => {
      const configured = servers(ctx);
      if (configured.length === 0) {
        ctx.ui.notify("lsp: no servers configured.", "info");
        return;
      }

      const lines = configured.map((server) => {
        const running = [...clients.entries()].filter(
          ([key, client]) => key.endsWith("\0" + server.id) && client.isAlive,
        );
        if (running.length > 0) {
          const details = running
            .map(([, client]) => client.root + " (pid " + client.pid + ")")
            .join(", ");
          return server.id + ": running — " + details;
        }
        if (missingBinaries.has(server.id)) {
          return server.id + ": not on PATH (" + server.command[0] + ")";
        }
        const failed = [...broken].filter((key) => key.endsWith("\0" + server.id));
        if (failed.length > 0) {
          return (
            server.id +
            ": failed to start — " +
            failed.map((key) => key.split("\0")[0]).join(", ")
          );
        }
        return server.id + ": idle (" + server.extensions.join(" ") + ")";
      });

      ctx.ui.notify("LSP servers:\n" + lines.join("\n"), "info");
    },
  });

  pi.on("session_shutdown", () => {
    for (const client of clients.values()) client.dispose();
    clients.clear();
  });
}
