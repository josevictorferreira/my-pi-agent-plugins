import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Checkpoint } from "./runner";

// Durable checkpoint store, independent of Pi's session file (which is only
// written once the session has an assistant message). One directory per
// working directory, one JSON file per run, so a run can be resumed from any
// later Pi session in the same project.

export interface CheckpointInfo {
  runId: string;
  step: number;
  status: string;
  objective: string;
  savedAt: Date;
}

function storeDir(cwd: string): string {
  return join(getAgentDir(), "skill-state", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

function fileFor(cwd: string, runId: string): string {
  return join(storeDir(cwd), runId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

export async function saveCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<string> {
  await mkdir(storeDir(cwd), { recursive: true });
  const path = fileFor(cwd, checkpoint.runId);
  await writeFile(path, JSON.stringify({ savedAt: new Date().toISOString(), checkpoint }), "utf8");
  return path;
}

export async function removeCheckpoint(cwd: string, runId: string): Promise<void> {
  await rm(fileFor(cwd, runId), { force: true });
}

export async function loadCheckpoint(cwd: string, runId: string): Promise<Checkpoint | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(cwd, runId), "utf8"));
    return parsed.checkpoint as Checkpoint;
  } catch {
    return undefined;
  }
}

/** Checkpoints for this working directory, newest first. */
export async function listCheckpoints(cwd: string): Promise<CheckpointInfo[]> {
  let names: string[];
  try {
    names = (await readdir(storeDir(cwd))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const infos: CheckpointInfo[] = [];
  for (const name of names) {
    const path = join(storeDir(cwd), name);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const cp = parsed.checkpoint as Checkpoint;
      infos.push({
        runId: cp.runId,
        step: cp.state.step,
        status: cp.state.status,
        objective: cp.objective,
        savedAt: new Date(parsed.savedAt ?? (await stat(path)).mtime),
      });
    } catch {
      // unreadable file: skip it
    }
  }
  return infos.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}
