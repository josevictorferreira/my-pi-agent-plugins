import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

/** A language server, fully resolved from built-in defaults plus user config. */
export interface LspServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  rootMarkers: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

type BuiltinServer = Omit<LspServerConfig, "id">;

/**
 * Small, data-driven catalog. Everything else comes from user config — this
 * extension never downloads or installs a server, so a built-in whose binary
 * is missing from PATH is simply skipped.
 */
export const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    rootMarkers: ["tsconfig.json", "package.json"],
  },
  gopls: {
    command: ["gopls"],
    extensions: [".go"],
    rootMarkers: ["go.work", "go.mod"],
  },
  rust: {
    command: ["rust-analyzer"],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
  },
  pyright: {
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
  },
  ruby: {
    command: ["ruby-lsp"],
    extensions: [".rb", ".rake", ".gemspec"],
    rootMarkers: ["Gemfile"],
  },
  nix: {
    command: ["nixd"],
    extensions: [".nix"],
    rootMarkers: ["flake.nix", "default.nix"],
  },
};

/** `didOpen` languageId per extension; unknown extensions use the bare suffix. */
const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".nix": "nix",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".json": "json",
  ".lua": "lua",
  ".php": "php",
  ".sh": "shellscript",
  ".svelte": "svelte",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
};

export function languageIdFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_IDS[ext] ?? (ext ? ext.slice(1) : "plaintext");
}

/** `true` when the whole extension is switched off via `PI_LSP_DISABLED`. */
export function isDisabledByEnv(): boolean {
  const value = (process.env.PI_LSP_DISABLED ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

/**
 * Nearest ancestor of `filePath` containing one of `markers`, searching no
 * higher than `cwd`. Falls back to `cwd` when nothing matches.
 */
export function findRoot(filePath: string, cwd: string, markers: string[]): string {
  let dir = dirname(resolve(filePath));
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    if (dir === cwd) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function normalizeExtension(ext: string): string {
  const lower = ext.trim().toLowerCase();
  return lower.startsWith(".") ? lower : "." + lower;
}

function readStringArray(
  value: unknown,
  label: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(label + " must be an array of strings");
    return undefined;
  }
  return value as string[];
}

function readStringRecord(
  value: unknown,
  label: string,
  errors: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(label + " must be an object");
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, v]) => typeof v !== "string")) {
    errors.push(label + " must map strings to strings");
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function readObject(
  value: unknown,
  label: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(label + " must be an object");
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readConfigFile(
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(path + ": top level must be an object of server ids");
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    errors.push(path + ": " + String(err));
    return undefined;
  }
}

export interface LoadedConfig {
  servers: LspServerConfig[];
  /** Human-readable config problems, surfaced once via `ctx.ui.notify`. */
  errors: string[];
}

/**
 * Built-in defaults <- `~/.pi/agent/lsp.json` <- `<cwd>/.pi/lsp.json`
 * (project file only when the project is trusted). Later files win per id;
 * `"disabled": true` removes a server entirely.
 */
export function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
  const errors: string[] = [];
  const resolved = new Map<string, LspServerConfig>();
  for (const [id, builtin] of Object.entries(BUILTIN_SERVERS)) {
    resolved.set(id, { id, ...builtin });
  }

  const paths = [join(getAgentDir(), "lsp.json")];
  if (projectTrusted) paths.push(join(cwd, CONFIG_DIR_NAME, "lsp.json"));

  for (const path of paths) {
    const data = readConfigFile(path, errors);
    if (!data) continue;

    for (const [id, rawEntry] of Object.entries(data)) {
      const label = path + ': "' + id + '"';
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        errors.push(label + " must be an object");
        continue;
      }
      const raw = rawEntry as Record<string, unknown>;
      if (raw.disabled === true) {
        resolved.delete(id);
        continue;
      }

      const base = resolved.get(id);
      const command = readStringArray(raw.command, label + " command", errors) ?? base?.command;
      const extensions =
        readStringArray(raw.extensions, label + " extensions", errors)?.map(normalizeExtension) ??
        base?.extensions;

      if (!command || command.length === 0) {
        errors.push(label + ' needs a non-empty "command" array');
        continue;
      }
      if (!extensions || extensions.length === 0) {
        errors.push(label + ' needs a non-empty "extensions" array');
        continue;
      }

      resolved.set(id, {
        id,
        command,
        extensions,
        rootMarkers:
          readStringArray(raw.rootMarkers, label + " rootMarkers", errors) ??
          base?.rootMarkers ??
          [],
        env: readStringRecord(raw.env, label + " env", errors) ?? base?.env,
        initialization:
          readObject(raw.initialization, label + " initialization", errors) ?? base?.initialization,
      });
    }
  }

  return { servers: [...resolved.values()], errors };
}
