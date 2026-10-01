import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Task registry shared by a root Pi session and every subagent it (transitively)
// launches. One directory per (cwd, root session), one JSON file per task.
// The launcher writes a record once before the pane exists, then only the child
// writes it, then only the closer writes it after the pane is gone, so no two
// processes ever write the same file concurrently and no locking is needed.
// Pi's own session file is not used because it is only flushed once the
// session has an assistant message (same reason skill-state has checkpoints.ts).

export type TaskStatus = "starting" | "running" | "idle" | "exited" | "closed";

export interface TaskRecord {
  id: string;
  parentSessionId: string;
  rootSessionId: string;
  type: string;
  title: string;
  prompt: string;
  /** "provider/id" the child was asked to use; undefined = Pi's default. */
  model?: string;
  fallbackModel?: string;
  /** tmux pane id, "%N". */
  paneId?: string;
  /** Written by the child on session_start. */
  sessionFile?: string;
  status: TaskStatus;
  /** Completed agent_settled count in the child. */
  turns: number;
  lastStopReason?: string;
  fellBack?: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export function newTaskId(): string {
  return randomUUID();
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function cwdDir(cwd: string): string {
  return join(getAgentDir(), "subagents", cwdSlug(cwd));
}

export function rootDir(cwd: string, rootSessionId: string): string {
  return join(cwdDir(cwd), rootSessionId);
}

function tasksDir(cwd: string, rootSessionId: string): string {
  return join(rootDir(cwd, rootSessionId), "tasks");
}

export function taskFile(cwd: string, rootSessionId: string, id: string, suffix = ".json"): string {
  return join(tasksDir(cwd, rootSessionId), id + suffix);
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = path + ".tmp-" + process.pid;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export async function writeTask(cwd: string, record: TaskRecord): Promise<string> {
  await mkdir(tasksDir(cwd, record.rootSessionId), { recursive: true });
  const path = taskFile(cwd, record.rootSessionId, record.id);
  await writeAtomic(path, JSON.stringify(record, null, 2));
  return path;
}

export async function readTask(cwd: string, rootSessionId: string, id: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await readFile(taskFile(cwd, rootSessionId, id), "utf8")) as TaskRecord;
  } catch {
    return undefined;
  }
}

/** Read-merge-write; `updatedAt` is always refreshed. Returns the new record or undefined if the task is unknown. */
export async function updateTask(
  cwd: string,
  rootSessionId: string,
  id: string,
  patch: Partial<TaskRecord>,
): Promise<TaskRecord | undefined> {
  const current = await readTask(cwd, rootSessionId, id);
  if (!current) return undefined;
  const next: TaskRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeAtomic(taskFile(cwd, rootSessionId, id), JSON.stringify(next, null, 2));
  return next;
}

export async function removeTask(cwd: string, rootSessionId: string, id: string): Promise<void> {
  for (const suffix of [".json", ".result.md", ".inbox.jsonl", ".system.md"]) {
    await rm(taskFile(cwd, rootSessionId, id, suffix), { force: true });
  }
}

/** Every task of a root, oldest first. */
export async function listTree(cwd: string, rootSessionId: string): Promise<TaskRecord[]> {
  let names: string[];
  try {
    names = await readdir(tasksDir(cwd, rootSessionId));
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readTask(cwd, rootSessionId, name.slice(0, -".json".length));
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Root session ids that have a registry under this cwd, newest directory first. */
export async function listRoots(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwdDir(cwd), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const stamped: Array<{ name: string; mtime: number }> = [];
    for (const name of dirs) {
      stamped.push({ name, mtime: (await stat(join(cwdDir(cwd), name))).mtimeMs });
    }
    return stamped.sort((a, b) => b.mtime - a.mtime).map((s) => s.name);
  } catch {
    return [];
  }
}

/** Tasks launched by `sessionId`. A child's session id is its task id. */
export function childrenOf(tree: TaskRecord[], sessionId: string): TaskRecord[] {
  return tree.filter((t) => t.parentSessionId === sessionId);
}

/** Depth-first descendants of a task, deepest first (the order they must be closed in). */
export function descendantsOf(tree: TaskRecord[], id: string): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const child of childrenOf(tree, id)) {
    out.push(...descendantsOf(tree, child.id), child);
  }
  return out;
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "exited" || status === "closed";
}

/** Exact id or a unique prefix of at least 4 characters. Throws a readable error otherwise. */
export function resolveTaskId(tree: TaskRecord[], ref: string): TaskRecord {
  const exact = tree.find((t) => t.id === ref);
  if (exact) return exact;
  if (ref.length < 4) throw new Error("task id \"" + ref + "\" is too short; use at least 4 characters");
  const matches = tree.filter((t) => t.id.startsWith(ref));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error("no task \"" + ref + "\"; known: " + (tree.map((t) => shortId(t.id)).join(", ") || "none"));
  }
  throw new Error("task id \"" + ref + "\" is ambiguous: " + matches.map((t) => shortId(t.id)).join(", "));
}

export async function writeResult(cwd: string, rootSessionId: string, id: string, text: string): Promise<void> {
  await writeAtomic(taskFile(cwd, rootSessionId, id, ".result.md"), text);
}

/** Result text capped at `maxBytes`; a cut result ends with a marker line. */
export async function readResult(cwd: string, rootSessionId: string, id: string, maxBytes: number): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(taskFile(cwd, rootSessionId, id, ".result.md"), "utf8");
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text).subarray(0, maxBytes).toString("utf8").replace(/�$/, "") +
    "\n... [truncated; call subagent_check for the full result]";
}

export async function writeSystemPrompt(cwd: string, rootSessionId: string, id: string, text: string): Promise<string> {
  await mkdir(tasksDir(cwd, rootSessionId), { recursive: true });
  const path = taskFile(cwd, rootSessionId, id, ".system.md");
  await writeAtomic(path, text);
  return path;
}

export interface InboxEntry {
  at: string;
  text: string;
}

export async function appendInbox(cwd: string, rootSessionId: string, id: string, text: string): Promise<void> {
  const entry: InboxEntry = { at: new Date().toISOString(), text };
  await appendFile(taskFile(cwd, rootSessionId, id, ".inbox.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

/** Complete inbox lines after byte `offset`; returns them with the new offset. A trailing partial line is left for the next read. */
export async function readInboxFrom(
  cwd: string,
  rootSessionId: string,
  id: string,
  offset: number,
): Promise<{ entries: InboxEntry[]; offset: number }> {
  let raw: Buffer;
  try {
    raw = await readFile(taskFile(cwd, rootSessionId, id, ".inbox.jsonl"));
  } catch {
    return { entries: [], offset };
  }
  if (raw.length <= offset) return { entries: [], offset };
  const chunk = raw.subarray(offset);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { entries: [], offset };
  const complete = chunk.subarray(0, lastNewline + 1).toString("utf8");
  const entries: InboxEntry[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as InboxEntry);
    } catch {
      // a corrupt line is skipped, not fatal
    }
  }
  return { entries, offset: offset + lastNewline + 1 };
}
