import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
const MAX_SEARCH_LINES = 80;
const MAX_SEARCH_FILES = 40;

export type ObservationKind = "ok" | "error" | "empty";

/** Extension tools made available to a run (see tool-registry.ts). */
export interface ToolRunner {
  has(name: string): boolean;
  run(name: string, params: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface ExecutionResult {
  observation: string;
  /** "error" when the action itself failed (bad path, no match, tool error); "empty" for a valid but empty result. */
  kind: ObservationKind;
  /** Path read by read_file (for inspectedFiles). */
  inspected?: string[];
  /** Path written by write_file / patch_file (for changedFiles). */
  changed?: string;
  /** Result of an exec_shell that ran a test, build or lint command (for checks). */
  check?: { command: string; code: number; summary: string };
}

interface ShellResult {
  code: number;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  /** A grandchild kept stdout/stderr open after the command exited (e.g. a daemon). */
  heldOpen: boolean;
}

// After the child exits, wait this long for its stdio to drain before giving
// up on it. A daemon started by the command inherits the stdio socket and
// would otherwise keep `close` from ever firing.
const DRAIN_GRACE_MS = 1000;

/**
 * Run a child in its own process group, collect stdout+stderr, and settle on
 * exit rather than on stdio close. Timeout and abort kill the whole group.
 */
function collect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellResult> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
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

    const settle = (code: number, heldOpen: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code, output: Buffer.concat(chunks).toString("utf8"), timedOut, aborted, heldOpen });
    };

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => {
      chunks.push(Buffer.from(String(err) + "\n"));
      settle(-1, false);
    });
    child.on("exit", (code, sig) => {
      const exitCode = code ?? (sig ? 128 : -1);
      grace = setTimeout(() => settle(exitCode, true), DRAIN_GRACE_MS);
    });
    child.on("close", (code, sig) => settle(code ?? (sig ? 128 : -1), false));
  });
}

// `rspec ... | tail -n 40` exits 0 under plain sh whatever rspec did. Probe once
// whether this system's sh knows pipefail (bash and busybox do, dash does not).
let pipefailSupport: Promise<boolean> | undefined;
function shSupportsPipefail(): Promise<boolean> {
  pipefailSupport ??= collect("sh", ["-c", "set -o pipefail"], process.cwd(), 5000, new AbortController().signal).then(
    (r) => r.code === 0,
    () => false,
  );
  return pipefailSupport;
}

async function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ShellResult> {
  const prefix = (await shSupportsPipefail()) ? "set -o pipefail; " : "";
  return collect("sh", ["-c", prefix + command], cwd, timeoutMs, signal);
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

/**
 * Search tracked and untracked-but-not-ignored files with `git grep`, so build
 * output, logs and vendored trees never reach the model. Outside a git work
 * tree fall back to `grep -r`. Returns the raw `path:line:text` lines.
 */
async function grepLines(cwd: string, pattern: string, glob: string | undefined, signal: AbortSignal): Promise<string[]> {
  let result = await collect(
    "git",
    ["grep", "-nIE", "--untracked", "--no-color", "-e", pattern, ...(glob ? ["--", glob] : [])],
    cwd,
    DEFAULT_TIMEOUT_MS,
    signal,
  );
  // 128 = not a git repository (or another git error); fall back to plain grep.
  if (result.code === 128) {
    const args = ["-rnIE", "--exclude-dir=.git", "--exclude-dir=node_modules"];
    if (glob) args.push("--include=" + glob);
    result = await collect("grep", [...args, "-e", pattern, "."], cwd, DEFAULT_TIMEOUT_MS, signal);
  }
  if (result.code === 1) return [];
  if (result.code !== 0) throw new Error("search failed (exit " + result.code + "): " + result.output.trim());
  return result.output
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.startsWith("./") ? l.slice(2) : l));
}

// Documentation, plans and agent skill files mention every product concept and
// crowd out code in search results. They rank last and never count as inspected.
const DOC_PATH = /(^|\/)(\.agents|docs?|wiki|notes)\/|\.(md|markdown|rst|html?|adoc)$/i;
const CODE_DIR = /^(app|lib|src|source|spec|specs|test|tests|__tests__|config|db|bin|cmd|internal|pkg|packages|extensions|server|client|api|core|domain)(\/|$)/;

export function isDocPath(path: string): boolean {
  return DOC_PATH.test(path);
}

/** 0 = source/test dirs, 1 = other code, 2 = documentation. */
function searchRank(path: string): number {
  if (isDocPath(path)) return 2;
  return CODE_DIR.test(path) ? 0 : 1;
}

/**
 * Bounded search observation. Up to MAX_SEARCH_LINES matches are shown in
 * full, code before documentation. Above that, listing a random window of
 * lines tells the model nothing, so it gets a per-file match map (code first,
 * then by count) and is asked to narrow the pattern.
 */
function formatSearch(lines: string[], pattern: string, glob: string | undefined): string {
  const scope = "/" + pattern + "/" + (glob ? " in " + glob : "");
  if (lines.length === 0) return "No matches for " + scope;
  const byFile = new Map<string, number>();
  for (const line of lines) {
    const path = line.slice(0, line.indexOf(":"));
    byFile.set(path, (byFile.get(path) ?? 0) + 1);
  }
  const pathOf = (l: string) => l.slice(0, l.indexOf(":"));
  if (lines.length <= MAX_SEARCH_LINES) {
    const ordered = [...lines].sort((a, b) => searchRank(pathOf(a)) - searchRank(pathOf(b)));
    return (
      lines.length + " matches in " + byFile.size + " files for " + scope + ":\n" +
      ordered.map((l) => (l.length > SEARCH_MAX_LINE_CHARS ? l.slice(0, SEARCH_MAX_LINE_CHARS) + " [truncated]" : l)).join("\n")
    );
  }
  const ranked = [...byFile.entries()].sort((a, b) => searchRank(a[0]) - searchRank(b[0]) || b[1] - a[1]);
  const top = ranked.slice(0, MAX_SEARCH_FILES);
  return (
    lines.length + " matches in " + byFile.size + " files for " + scope + ". Too many to list; matches per file" +
    (ranked.length > top.length ? " (top " + top.length + ")" : "") +
    ":\n" +
    top.map(([path, n]) => path + " (" + n + ")").join("\n") +
    "\nNarrow the pattern (use identifiers, not words) or add a glob, or read_file one of these paths."
  );
}

/**
 * For a path that does not exist, describe the nearest existing ancestor and
 * its entries so the model can correct the path instead of guessing again.
 */
async function describeMissing(cwd: string, absolute: string, rel: string): Promise<string> {
  let dir = dirname(absolute);
  while (dir.startsWith(cwd)) {
    try {
      if ((await stat(dir)).isDirectory()) break;
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith("."))
    .map((e) => e.name + (e.isDirectory() ? "/" : ""))
    .sort()
    .slice(0, 60);
  const shown = relative(cwd, dir) || ".";
  return "No such file: " + rel + ". Nearest existing directory " + shown + " contains: " + entries.join(", ");
}

async function readText(cwd: string, absolute: string, rel: string): Promise<string> {
  try {
    return await readFile(absolute, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(await describeMissing(cwd, absolute, rel));
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      const entries = (await readdir(absolute)).sort().slice(0, 60);
      throw new Error(rel + " is a directory containing: " + entries.join(", "));
    }
    throw err;
  }
}

// Line numbers are padded to one width and separated from the text by "│"
// with no space, so the prefix cannot blend into the indentation. Models were
// observed copying indented code back at the wrong depth when the prefix was
// "N: " (the trailing space merges with leading whitespace).
export const LINE_FORMAT_NOTE = "line│text; everything after │ is exact, including indentation";

export function numberLines(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => String(start + i).padStart(width) + "│" + l).join("\n");
}

async function readFileWindow(cwd: string, path: string, offset: number | undefined, limit: number | undefined): Promise<string> {
  const { absolute, rel } = safePath(cwd, path);
  const text = await readText(cwd, absolute, rel);
  const lines = text.split("\n");
  const start = Math.max(1, offset ?? 1);
  const count = limit ?? MAX_OBS_LINES;
  const window = lines.slice(start - 1, start - 1 + count);
  if (window.length === 0) {
    return rel + " has " + lines.length + " lines; offset " + start + " is past the end.";
  }
  const bounded = truncateHead(numberLines(window, start), { maxLines: MAX_OBS_LINES, maxBytes: MAX_OBS_BYTES });
  const shownEnd = start + bounded.outputLines - 1;
  let out = rel + " lines " + start + "-" + shownEnd + " of " + lines.length + " (" + LINE_FORMAT_NOTE + "):\n" + bounded.content;
  if (shownEnd < lines.length) {
    out += "\n[truncated; continue with read_file offset=" + (shownEnd + 1) + " limit=" + MAX_OBS_LINES + "]";
  }
  return out;
}

const leadingWs = (line: string): string => /^[ \t]*/.exec(line)![0];

/** Re-indent one line of newText by the difference between the model's and the file's indentation. */
function reindent(line: string, oldIndent: string, fileIndent: string): string {
  if (!line.trim()) return line;
  if (line.startsWith(oldIndent)) return fileIndent + line.slice(oldIndent.length);
  const delta = fileIndent.length - oldIndent.length;
  if (delta >= 0) return fileIndent.slice(0, delta) + line;
  const ws = leadingWs(line);
  return ws.slice(0, Math.max(0, ws.length + delta)) + line.slice(ws.length);
}

/**
 * Apply the patch. Exact match first; then a line-by-line match that ignores
 * leading and trailing whitespace, in which case newText is re-indented by the
 * same difference. On no match, the error shows the file where oldText's first
 * line occurs, numbered and exact, so the next attempt has the real text
 * instead of a second guess (10 of 15 patches failed on this in one run).
 */
export function applyPatch(text: string, oldText: string, newText: string, rel: string): { text: string; note: string } {
  const first = text.indexOf(oldText);
  if (first !== -1) {
    if (text.indexOf(oldText, first + oldText.length) !== -1) {
      throw new Error("oldText matches more than once in " + rel + "; include more surrounding context");
    }
    return {
      text: text.slice(0, first) + newText + text.slice(first + oldText.length),
      note: "Patched " + rel + " (" + oldText.split("\n").length + " → " + newText.split("\n").length + " lines)",
    };
  }
  const fileLines = text.split("\n");
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // A trailing newline in oldText/newText is a line boundary, not a line.
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === "") {
    oldLines.pop();
    if (newLines[newLines.length - 1] === "") newLines.pop();
  }
  const target = oldLines.map((l) => l.trim());
  const anchorIndex = target.findIndex((l) => l);
  if (anchorIndex === -1) throw new Error("oldText not found in " + rel + " (it is blank)");
  const starts: number[] = [];
  for (let i = 0; i + target.length <= fileLines.length; i++) {
    let match = true;
    for (let j = 0; j < target.length && match; j++) match = fileLines[i + j].trim() === target[j];
    if (match) starts.push(i);
  }
  if (starts.length > 1) {
    throw new Error(
      "oldText matches at lines " + starts.map((s) => s + 1).join(", ") + " of " + rel +
        " when indentation is ignored; include more surrounding context",
    );
  }
  if (starts.length === 1) {
    const start = starts[0];
    const fileIndent = leadingWs(fileLines[start + anchorIndex]);
    const oldIndent = leadingWs(oldLines[anchorIndex]);
    const replacement = newLines.map((l) => reindent(l, oldIndent, fileIndent));
    const out = [...fileLines.slice(0, start), ...replacement, ...fileLines.slice(start + oldLines.length)].join("\n");
    return {
      text: out,
      note:
        "Patched " + rel + " lines " + (start + 1) + "-" + (start + oldLines.length) + " (" + oldLines.length + " → " + replacement.length +
        " lines). Your oldText was indented " + oldIndent.length + " chars, the file " + fileIndent.length +
        "; newText was re-indented to match. Copy indentation exactly next time.",
    };
  }
  const anchor = target[anchorIndex];
  const at = fileLines.findIndex((l) => l.trim() === anchor);
  if (at === -1) {
    throw new Error(
      "oldText not found in " + rel + ": no line of the file equals its first line " + JSON.stringify(anchor.slice(0, 100)) +
        " (compared without indentation). read_file the region and copy the text exactly.",
    );
  }
  const from = Math.max(0, at - anchorIndex);
  const shown = fileLines.slice(from, Math.min(fileLines.length, from + oldLines.length + 2));
  throw new Error(
    "oldText not found in " + rel + ": its first line is at line " + (at + 1) + " but the following lines differ. " +
      "The file there reads (" + LINE_FORMAT_NOTE + "):\n" + numberLines(shown, from + 1) + "\nUse this exact text as oldText.",
  );
}

async function patchFile(cwd: string, path: string, oldText: string, newText: string): Promise<string> {
  const { absolute, rel } = safePath(cwd, path);
  const text = await readText(cwd, absolute, rel);
  const patched = applyPatch(text, oldText, newText, rel);
  await writeFile(absolute, patched.text, "utf8");
  return patched.note;
}

// Only test/build/lint runs are checks. sed, awk, grep, ls and friends through
// exec_shell are reads and would otherwise fill `checks` with "sed -n ... | cat -A".
const CHECK_COMMAND =
  /\b(bundle|rspec|rake|rails|npm|bun|pnpm|yarn|npx|pytest|jest|vitest|mocha|cargo|go (test|build|vet)|make|mix|dotnet|mvn|gradle|tsc|eslint|rubocop|phpunit|ctest|swift test)\b|--check\b|\bruby -c\b|-m (pytest|unittest)\b/;
export function isCheckCommand(command: string): boolean {
  return CHECK_COMMAND.test(command);
}

// Test runners that exit 0 through a `| tail` still say so in their output.
const FAILURE_SIGNS = [
  /\b[1-9]\d* (failures?|failed|errors?|offenses?)\b/i,
  /\b(FAILED|FAILURES|FAIL)\b/,
  /Traceback \(most recent call last\)/,
  /\berror\[E\d+\]/,
  /\berror TS\d{4}:/,
];
/** The first line of output that reports a failure, or undefined. */
export function reportedFailure(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (FAILURE_SIGNS.some((re) => re.test(line))) return line.trim().slice(0, 160);
  }
  return undefined;
}

/** Execute one action. Never throws: failures become error observations. */
export async function execute(action: RepoAction, cwd: string, signal: AbortSignal, tools?: ToolRunner): Promise<ExecutionResult> {
  const header = "Result of " + (action.type === "tool" ? "tool " + action.name : action.type) + ":\n";
  try {
    switch (action.type) {
      case "search_files": {
        const lines = await grepLines(cwd, action.pattern, action.glob, signal);
        // Matched files are not inspected files: a broad pattern once added 13
        // schema and migration files the model never opened.
        return { observation: header + boundOutput(formatSearch(lines, action.pattern, action.glob)), kind: lines.length ? "ok" : "empty" };
      }
      case "read_file": {
        const out = await readFileWindow(cwd, action.path, action.offset, action.limit);
        return { observation: header + out, inspected: [safePath(cwd, action.path).rel], kind: out.includes(" is past the end.") ? "empty" : "ok" };
      }
      case "tool": {
        if (!tools || !tools.has(action.name)) throw new Error("no such tool: " + action.name);
        const out = await tools.run(action.name, action.params as Record<string, unknown>, signal);
        return { observation: header + boundOutput(out), kind: out.trim() ? "ok" : "empty" };
      }
      case "write_file": {
        const { absolute, rel } = safePath(cwd, action.path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, action.content, "utf8");
        return {
          observation: header + "Wrote " + rel + " (" + action.content.split("\n").length + " lines)",
          changed: rel,
          kind: "ok",
        };
      }
      case "patch_file": {
        const out = await patchFile(cwd, action.path, action.oldText, action.newText);
        return { observation: header + out, changed: safePath(cwd, action.path).rel, kind: "ok" };
      }
      case "exec_shell": {
        const timeoutMs = Math.min(action.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const result = await runShell(action.command, cwd, timeoutMs, signal);
        const status = result.aborted
          ? "aborted"
          : result.timedOut
            ? "timed out after " + timeoutMs + " ms"
            : "exit code " + result.code;
        const note = result.heldOpen
          ? "\n[a background process started by this command is still running and kept its output open; output may be incomplete]"
          : "";
        const failure = result.code === 0 && !result.timedOut ? reportedFailure(result.output) : undefined;
        const masked = failure ? " (but the output reports a failure: \"" + failure + "\"; treat this as failed)" : "";
        const body = "$ " + action.command + "\n" + status + masked + note + "\n" + boundOutput(result.output);
        const lastLine = result.output.trim().split("\n").pop() ?? "";
        return {
          observation: header + body,
          kind: result.output.trim() ? "ok" : "empty",
          check: isCheckCommand(action.command)
            ? {
                command: action.command.slice(0, 120),
                code: result.timedOut ? 124 : result.code,
                summary: (result.timedOut ? "timeout; " : "") + (failure ? "exit 0 but output reports: " + failure : lastLine.slice(0, 160)),
              }
            : undefined,
        };
      }
      case "git_diff": {
        const paths = (action.paths ?? []).map((p) => safePath(cwd, p).rel);
        const command = ["git", "diff", "--", ...paths.map((p) => "'" + p.replace(/'/g, "'\\''") + "'")].join(" ");
        const result = await runShell(command, cwd, DEFAULT_TIMEOUT_MS, signal);
        return {
          observation: header + (result.output.trim() ? boundOutput(result.output) : "No uncommitted changes."),
          kind: result.output.trim() ? "ok" : "empty",
        };
      }
      case "finish":
        return { observation: header + "Run finished.", kind: "ok" };
    }
  } catch (err) {
    return { observation: header + "Error: " + ((err as Error).message ?? String(err)), kind: "error" };
  }
}
