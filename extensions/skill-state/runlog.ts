import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "./runner";

// Per-run JSONL trace: every prompt, reply, rejection, state and observation,
// appended synchronously as it happens so a hang or crash still leaves the
// trail up to that point. Lives next to the checkpoint store:
//   ~/.pi/agent/skill-state/<working-directory>/logs/<runId>.jsonl
// A resumed run appends to the same file.

export function runLogDir(cwd: string): string {
  return join(getAgentDir(), "skill-state", cwd.replace(/[^A-Za-z0-9]/g, "-"), "logs");
}

export function runLogPath(cwd: string, runId: string): string {
  return join(runLogDir(cwd), runId.replace(/[^A-Za-z0-9_-]/g, "_") + ".jsonl");
}

export interface RunLog {
  path: string;
  write: (event: RunEvent) => void;
}

export function openRunLog(cwd: string, runId: string): RunLog {
  const path = runLogPath(cwd, runId);
  mkdirSync(runLogDir(cwd), { recursive: true });
  return {
    path,
    write: (event) => {
      try {
        appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
      } catch {
        // Logging must never take the run down.
      }
    },
  };
}

export interface RunLogInfo {
  runId: string;
  path: string;
  modified: Date;
  steps: number;
  /** "completed", "failed (cannot_complete)", ... or "in progress / no end". */
  outcome: string;
  objective: string;
}

/** Run logs for a working directory, newest first. Tolerates partial files. */
export function listRunLogs(cwd: string): RunLogInfo[] {
  const dir = runLogDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const infos: RunLogInfo[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let steps = 0;
    let objective = "";
    let outcome = "in progress / no end";
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // torn last line while a run is writing
        }
        if (event.type === "run_start" && !objective) objective = event.objective ?? "";
        else if (event.type === "step") steps = event.step;
        else if (event.type === "run_end") {
          const s = event.summary;
          outcome = s.status + (s.outcome ? " (" + s.outcome + ")" : "");
        }
      }
    } catch {
      continue;
    }
    infos.push({ runId: name.replace(/\.jsonl$/, ""), path, modified: statSync(path).mtime, steps, outcome, objective });
  }
  return infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
