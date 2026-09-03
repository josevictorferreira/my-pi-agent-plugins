#!/usr/bin/env bun
// Inspect SKILL.state run logs (~/.pi/agent/skill-state/<cwd>/logs/<runId>.jsonl).
//
//   bun extensions/skill-state/tools/runlog.ts                      # list runs for the current directory
//   bun extensions/skill-state/tools/runlog.ts <runId|path>         # step table + summary
//   bun extensions/skill-state/tools/runlog.ts <runId|path> --step N            # one step: patch, action, rejections, observation, state
//   bun extensions/skill-state/tools/runlog.ts <runId|path> --step N --prompt   # the prompt of the last attempt of step N
//   bun extensions/skill-state/tools/runlog.ts <runId|path> --step N --reply    # the raw model reply of that attempt
//   bun extensions/skill-state/tools/runlog.ts <runId|path> --step N --attempt K --prompt|--reply
//   bun extensions/skill-state/tools/runlog.ts <runId|path> --rejections        # every rejected attempt with its errors
// Add --cwd <dir> to look at another project's logs.

import { existsSync, readFileSync } from "node:fs";
import { listRunLogs, runLogDir, runLogPath } from "../runlog";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(name);
const cwd = flag("--cwd") ?? process.cwd();
const VALUE_FLAGS = new Set(["--step", "--attempt", "--cwd"]);
let target: string | undefined;
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) i++;
  else if (!argv[i].startsWith("--")) {
    target = argv[i];
    break;
  }
}

function pad(v: unknown, n: number): string {
  return String(v).padEnd(n);
}
function rpad(v: unknown, n: number): string {
  return String(v).padStart(n);
}
function clip(text: string, n: number): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

if (!target) {
  const runs = listRunLogs(cwd);
  if (!runs.length) {
    console.log("No run logs for " + cwd + " (" + runLogDir(cwd) + ")");
    process.exit(0);
  }
  console.log("Run logs for " + cwd + " (" + runLogDir(cwd) + "):");
  for (const r of runs) {
    console.log(
      "  " + pad(r.runId, 16) + pad(r.modified.toISOString().slice(0, 16), 18) + rpad(r.steps, 4) + " steps  " +
        pad(r.outcome, 28) + clip(r.objective, 60),
    );
  }
  process.exit(0);
}

const path = existsSync(target) ? target : runLogPath(cwd, target);
if (!existsSync(path)) {
  console.error("No such log: " + path);
  process.exit(1);
}
const events = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const stepN = flag("--step") ? Number(flag("--step")) : undefined;

if (has("--rejections")) {
  for (const e of events) {
    if (e.type === "attempt" && e.errors.length) {
      console.log("step " + e.step + " attempt " + e.attempt + ":");
      for (const err of e.errors) console.log("  - " + err);
    }
    if (e.type === "provider_error") console.log("step " + e.step + " provider attempt " + e.attempt + ": " + e.error);
  }
  process.exit(0);
}

if (stepN !== undefined) {
  const attempts = events.filter((e) => e.type === "attempt" && e.step === stepN);
  const step = events.find((e) => e.type === "step" && e.step === stepN);
  const attemptN = flag("--attempt") ? Number(flag("--attempt")) : attempts.length;
  const attempt = attempts.find((a) => a.attempt === attemptN);
  if (has("--prompt") || has("--reply")) {
    if (!attempt) {
      console.error("No attempt " + attemptN + " for step " + stepN);
      process.exit(1);
    }
    console.log(has("--prompt") ? attempt.prompt : attempt.reply);
    process.exit(0);
  }
  console.log("Step " + stepN + ": " + attempts.length + " attempt(s)");
  for (const a of attempts) {
    console.log("  attempt " + a.attempt + "  " + a.durationMs + " ms  in " + (a.usage?.input ?? "?") + " / out " + (a.usage?.output ?? "?") + (a.errors.length ? "  REJECTED" : "  accepted"));
    for (const err of a.errors) console.log("    - " + err);
  }
  for (const e of events.filter((e) => e.type === "provider_error" && e.step === stepN)) {
    console.log("  provider attempt " + e.attempt + " failed after " + e.durationMs + " ms: " + e.error);
  }
  if (!step) {
    console.log("  (step not completed)");
    process.exit(0);
  }
  console.log("\nstate_patch: " + JSON.stringify(step.statePatch));
  console.log("action:      " + JSON.stringify(step.action).slice(0, 2000));
  console.log("\nobservation (" + step.telemetry.observationBytes + " B):\n" + (has("--full") ? step.observation : clip(step.observation, 3000)));
  console.log("\nstate after (" + step.telemetry.stateBytes + " B):\n" + JSON.stringify(step.state, null, 1));
  process.exit(0);
}

// Default: step table + summary.
const start = events.find((e) => e.type === "run_start");
if (start) {
  console.log("run " + start.runId + (start.model ? "  model " + start.model : "") + "  maxSteps " + start.maxSteps + (start.resumedFrom !== undefined ? "  resumed from step " + start.resumedFrom : ""));
  console.log("objective: " + clip(start.objective, 200) + "\n");
}
console.log(pad("step", 5) + pad("status", 11) + pad("action", 13) + rpad("promptB", 8) + rpad("stateB", 7) + rpad("obsB", 6) + rpad("in", 6) + rpad("out", 5) + rpad("rej", 4) + rpad("prov", 5) + rpad("rr", 3) + rpad("ms", 7) + "  detail");
for (const e of events) {
  if (e.type !== "step") continue;
  const t = e.telemetry;
  const a = e.action;
  const detail =
    a.type === "read_file" ? a.path + (a.offset ? ":" + a.offset : "")
    : a.type === "search_files" ? "/" + a.pattern + "/" + (a.glob ? " " + a.glob : "")
    : a.type === "exec_shell" ? clip(a.command, 60)
    : a.type === "patch_file" || a.type === "write_file" ? a.path
    : a.type === "finish" ? a.outcome + ": " + clip(a.summary, 60)
    : "";
  console.log(
    pad(t.step, 5) + pad(t.status, 11) + pad(a.type, 13) + rpad(t.promptBytes, 8) + rpad(t.stateBytes, 7) + rpad(t.observationBytes, 6) +
      rpad(t.input, 6) + rpad(t.output, 5) + rpad(t.retries, 4) + rpad(t.providerRetries, 5) + rpad(t.reReadCount, 3) + rpad(t.durationMs, 7) + "  " + detail,
  );
}
const ends = events.filter((e) => e.type === "run_end");
const end = ends[ends.length - 1];
if (end) {
  const s = end.summary;
  console.log("\n" + s.status + (s.outcome ? " (" + s.outcome + ")" : "") + " after " + s.steps + " steps; tokens in/out " + s.totals.input + "/" + s.totals.output + "; re-reads " + s.reReadCount);
  if (s.error) console.log("error: " + s.error);
  if (s.summary) console.log("summary: " + s.summary);
  if (s.blockers.length) console.log("blockers:\n  - " + s.blockers.join("\n  - "));
  if (s.changedFiles.length) console.log("changed: " + s.changedFiles.join(", "));
} else {
  console.log("\n(no run_end yet: in progress, or the process died)");
}
