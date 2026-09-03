import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { RepoAction } from "./schemas";

// Observation bounds (plan §5.4): the whole observation is ≤ 200 lines / 8 KB
// so the per-step prompt stays O(1) regardless of what the action returned.
export const MAX_OBS_LINES = 200;
export const MAX_OBS_BYTES = 8 * 1024;
const HEAD_SHARE = 0.7;

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
const SEARCH_MAX_LINE_CHARS = 300;

export interface ExecutionResult {
  observation: string;
  /** Path read by read_file or matched by search_files (for inspectedFiles). */
  inspected?: string[];
  /** Path written by write_file / patch_file (for changedFiles). */
  changed?: string;
  /** exec_shell result summary (for checks). */
  check?: { command: string; code: number; summary: string };
}

interface ShellResult {
  code: number;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ShellResult> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => chunks.push(Buffer.from(String(err) + "\n")));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      done({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8"), timedOut, aborted });
    });
  });
}

/** Resolve a model-supplied path under cwd; throws a plain message when it escapes. */
function safePath(cwd: string, input: string): { absolute: string; rel: string } {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const rel = relative(cwd, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes the repository root: " + input);
  }
  return { absolute, rel };
}

/** Head 70 % / tail 30 % bounding for command output. */
function boundOutput(text: string): string {
  const total = truncateHead(text, { maxLines: MAX_OBS_LINES, maxBytes: MAX_OBS_BYTES });
  if (!total.truncated) return text;
  const head = truncateHead(text, {
    maxLines: Math.floor(MAX_OBS_LINES * HEAD_SHARE),
    maxBytes: Math.floor(MAX_OBS_BYTES * HEAD_SHARE),
  });
  const tail = truncateTail(text, {
    maxLines: MAX_OBS_LINES - Math.floor(MAX_OBS_LINES * HEAD_SHARE),
    maxBytes: MAX_OBS_BYTES - Math.floor(MAX_OBS_BYTES * HEAD_SHARE),
  });
  return (
    head.content.trimEnd() +
    "\n[... " +
    (total.totalLines - head.outputLines - tail.outputLines) +
    " of " +
    total.totalLines +
    " lines omitted ...]\n" +
    tail.content
  );
}

async function searchFiles(cwd: string, pattern: string, glob: string | undefined, signal: AbortSignal): Promise<string> {
  const args = ["-rnIE", "--exclude-dir=.git", "--exclude-dir=node_modules"];
  if (glob) args.push("--include=" + glob);
  args.push("-e", pattern, ".");
  const result = await new Promise<ShellResult>((done) => {
    const child = spawn("grep", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => chunks.push(Buffer.from(String(err))));
    child.on("close", (code) =>
      done({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8"), timedOut: false, aborted: signal.aborted }),
    );
  });
  if (result.code === 1) return "No matches for /" + pattern + "/" + (glob ? " in " + glob : "");
  if (result.code !== 0) return "grep failed (exit " + result.code + "):\n" + result.output;
  const lines = result.output
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.startsWith("./") ? l.slice(2) : l))
    .map((l) => (l.length > SEARCH_MAX_LINE_CHARS ? l.slice(0, SEARCH_MAX_LINE_CHARS) + " [truncated]" : l));
  return lines.length + " matching lines:\n" + lines.join("\n");
}

function matchedPaths(searchOutput: string): string[] {
  const paths = new Set<string>();
  for (const line of searchOutput.split("\n")) {
    const m = /^([^:\n]+):\d+:/.exec(line);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

async function readFileWindow(cwd: string, path: string, offset: number | undefined, limit: number | undefined): Promise<string> {
  const { absolute, rel } = safePath(cwd, path);
  const text = await readFile(absolute, "utf8");
  const lines = text.split("\n");
  const start = Math.max(1, offset ?? 1);
  const count = limit ?? MAX_OBS_LINES;
  const window = lines.slice(start - 1, start - 1 + count);
  if (window.length === 0) {
    return rel + " has " + lines.length + " lines; offset " + start + " is past the end.";
  }
  const numbered = window.map((l, i) => String(start + i) + ": " + l).join("\n");
  const bounded = truncateHead(numbered, { maxLines: MAX_OBS_LINES, maxBytes: MAX_OBS_BYTES });
  const shownEnd = start + bounded.outputLines - 1;
  let out = rel + " lines " + start + "-" + shownEnd + " of " + lines.length + ":\n" + bounded.content;
  if (shownEnd < lines.length) {
    out += "\n[truncated; continue with read_file offset=" + (shownEnd + 1) + " limit=" + MAX_OBS_LINES + "]";
  }
  return out;
}

async function patchFile(cwd: string, path: string, oldText: string, newText: string): Promise<string> {
  const { absolute, rel } = safePath(cwd, path);
  const text = await readFile(absolute, "utf8");
  const first = text.indexOf(oldText);
  if (first === -1) throw new Error("oldText not found in " + rel + "; read the file and copy the exact text");
  if (text.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("oldText matches more than once in " + rel + "; include more surrounding context");
  }
  await writeFile(absolute, text.slice(0, first) + newText + text.slice(first + oldText.length), "utf8");
  return "Patched " + rel + " (" + oldText.split("\n").length + " → " + newText.split("\n").length + " lines)";
}

/** Execute one action. Never throws: failures become error observations. */
export async function execute(action: RepoAction, cwd: string, signal: AbortSignal): Promise<ExecutionResult> {
  const header = "Result of " + action.type + ":\n";
  try {
    switch (action.type) {
      case "search_files": {
        const out = await searchFiles(cwd, action.pattern, action.glob, signal);
        return { observation: header + boundOutput(out), inspected: matchedPaths(out) };
      }
      case "read_file": {
        const out = await readFileWindow(cwd, action.path, action.offset, action.limit);
        return { observation: header + out, inspected: [safePath(cwd, action.path).rel] };
      }
      case "write_file": {
        const { absolute, rel } = safePath(cwd, action.path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, action.content, "utf8");
        return {
          observation: header + "Wrote " + rel + " (" + action.content.split("\n").length + " lines)",
          changed: rel,
        };
      }
      case "patch_file": {
        const out = await patchFile(cwd, action.path, action.oldText, action.newText);
        return { observation: header + out, changed: safePath(cwd, action.path).rel };
      }
      case "exec_shell": {
        const timeoutMs = Math.min(action.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const result = await runShell(action.command, cwd, timeoutMs, signal);
        const status = result.aborted
          ? "aborted"
          : result.timedOut
            ? "timed out after " + timeoutMs + " ms"
            : "exit code " + result.code;
        const body = "$ " + action.command + "\n" + status + "\n" + boundOutput(result.output);
        const lastLine = result.output.trim().split("\n").pop() ?? "";
        return {
          observation: header + body,
          check: {
            command: action.command.slice(0, 120),
            code: result.timedOut ? 124 : result.code,
            summary: (result.timedOut ? "timeout; " : "") + lastLine.slice(0, 160),
          },
        };
      }
      case "git_diff": {
        const paths = (action.paths ?? []).map((p) => safePath(cwd, p).rel);
        const command = ["git", "diff", "--", ...paths.map((p) => "'" + p.replace(/'/g, "'\\''") + "'")].join(" ");
        const result = await runShell(command, cwd, DEFAULT_TIMEOUT_MS, signal);
        return { observation: header + (result.output.trim() ? boundOutput(result.output) : "No uncommitted changes.") };
      }
      case "finish":
        return { observation: header + "Run finished." };
    }
  } catch (err) {
    return { observation: header + "Error: " + ((err as Error).message ?? String(err)) };
  }
}
