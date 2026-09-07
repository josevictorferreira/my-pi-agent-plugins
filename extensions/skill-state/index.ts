import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { bindModel } from "./model";
import { DEFAULT_MAX_STEPS, run, type Checkpoint, type CompleteFn, type RunOptions, type RunSummary, type StepProgress, type StepTelemetry } from "./runner";
import type { SkillExecutionState } from "./schemas";
import { listCheckpoints, loadCheckpoint, removeCheckpoint, saveCheckpoint } from "./checkpoints";
import { listRunLogs, openRunLog, runLogDir } from "./runlog";
import { hasStateRunTool, listStateRunTools, runStateRunTool, validateToolParams } from "./tool-registry";
import { expandObjective, loadSpec } from "./workflow";

const MAX_RESULT_CHARS = 1024;

// The paper ran at temperature 0, but several upstreams behind Pi providers
// reject the parameter outright (HTTP 400), and Pi itself never sends it.
// Portability across models is the mechanism under test, so sampling
// temperature is opt-in: SKILL_STATE_TEMPERATURE=0 restores the paper setting.
function configuredTemperature(): number | undefined {
  const raw = process.env.SKILL_STATE_TEMPERATURE;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("SKILL_STATE_TEMPERATURE must be a non-negative number");
  return value;
}

interface ParsedArgs {
  objective: string;
  skill?: string;
  maxSteps: number;
  requireReasoning: boolean;
  tools: boolean;
}

/**
 * `/state-run [--skill <path>] [--max-steps N] [--reasoning required|optional] [--tools] <objective>`
 *
 * Extension tools are opt-in: their vocabulary is 1.6 KB of every prompt and a
 * 372-call run used them zero times (improvements_3 §9).
 */
export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let skill: string | undefined;
  let maxSteps = DEFAULT_MAX_STEPS;
  let requireReasoning = false;
  let tools = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--skill" && tokens[i + 1]) skill = tokens[++i];
    else if (token === "--max-steps" && tokens[i + 1]) {
      const n = Number.parseInt(tokens[++i], 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("--max-steps must be a positive integer");
      maxSteps = n;
    } else if (token === "--reasoning" && tokens[i + 1]) {
      const v = tokens[++i];
      if (v !== "required" && v !== "optional") throw new Error("--reasoning must be required or optional");
      requireReasoning = v === "required";
    } else if (token === "--tools") tools = true;
    else rest.push(token);
  }
  // An objective typed in quotes would otherwise carry them into every prompt.
  const objective = rest.join(" ").replace(/^["'“]([\s\S]*)["'”]$/, "$1").trim();
  return { objective, skill, maxSteps, requireReasoning, tools };
}

/** Extension tools shared through tool-registry.ts, as the runner expects them. */
function toolRunner(ctx: ExtensionCommandContext): RunOptions["tools"] {
  const specs = listStateRunTools();
  if (!specs.length) return undefined;
  const vocabulary =
    "Extension tools, as {\"type\":\"tool\",\"name\":\"<name>\",\"params\":{...}} (read-only; results are bounded like any observation):\n" +
    specs.map((t) => "- " + t.name + " {" + t.params.join(", ") + "}  " + t.description).join("\n");
  return {
    vocabulary,
    has: hasStateRunTool,
    validate: validateToolParams,
    run: (name, params, signal) => runStateRunTool(name, params, signal, ctx),
  };
}

/**
 * Bind the session model to the runner's `complete` contract (model.ts): auth
 * resolved once per run, optional temperature, and the session's thinking level
 * (`/thinking`). With no level, or "off", the run asks for no provider thinking:
 * reasoning is meant to be textual, as in the paper's Appendix A.4, and hidden
 * reasoning was 90 % of one run's output tokens. `usage.reasoning` records
 * whatever the provider still reports.
 */
async function makeComplete(ctx: ExtensionCommandContext, runId: string): Promise<CompleteFn> {
  const model = ctx.model;
  if (!model) throw new Error("no model selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const target = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  return bindModel(target, auth, { runId, thinking: ctx.thinkingLevel ?? "off", temperature: configuredTemperature() });
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + "…" : text);

function tokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k" : String(n);
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
}

/**
 * The panel above the editor while a run is going. A step can take minutes, so
 * the run's position, what it is doing right now and how the last step went are
 * pinned instead of scrolling past in the transcript.
 */
export function widgetLines(
  view: {
    runId: string;
    maxSteps: number;
    progress?: StepProgress;
    last?: StepTelemetry;
    state?: SkillExecutionState;
    phaseSince: number;
  },
  theme: { fg: (c: any, t: string) => string; bold: (t: string) => string },
): string {
  const { progress, last, state } = view;
  const step = progress?.step ?? last?.step ?? 0;
  const status = progress?.status ?? last?.status ?? state?.status ?? "inspecting";
  const head =
    theme.fg("dim", "state-run " + view.runId + "  ") +
    theme.fg("accent", "step " + step + "/" + view.maxSteps) + "  " + theme.bold(status) +
    theme.fg("dim",
      (state?.changedFiles.length ? "  " + state.changedFiles.length + " changed" : "") +
      (state?.checks.length ? "  " + state.checks.length + (state.checks.length === 1 ? " check" : " checks") : ""));
  const elapsed = duration(Date.now() - view.phaseSince);
  const now = progress
    ? (progress.phase === "thinking"
        ? theme.fg("muted", "thinking" + (progress.attempt > 1 ? " (attempt " + progress.attempt + ")" : ""))
        : clip(progress.actionSummary ?? "", 110))
    : theme.fg("muted", "idle");
  const lines = [head, theme.fg("dim", "  now   ") + now + theme.fg("dim", "  " + elapsed)];
  if (last?.resultLine) {
    const ok = last.resultOk ?? last.actionOk;
    lines.push(
      theme.fg("dim", "  last  ") + (ok ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ")) +
        theme.fg(ok ? "toolOutput" : "error", clip(last.resultLine, 110)),
    );
  }
  const next = state?.plan[0];
  if (next) {
    lines.push(
      theme.fg("dim", "  plan  ") + clip(next, 110) +
        (state.plan.length > 1 ? theme.fg("dim", "  (+" + (state.plan.length - 1) + " more)") : ""),
    );
  }
  return lines.join("\n");
}

/** ≤ 1 KB projection of the run for the outer conversation (plan §8). */
function resultMessage(summary: RunSummary): string {
  const lines = [
    "SKILL.state run " + summary.status + " after " + summary.steps + " steps.",
    "Objective: " + summary.objective,
  ];
  if (summary.outcome) lines.push("Outcome: " + summary.outcome);
  if (summary.summary) lines.push("Summary: " + summary.summary);
  if (summary.error) lines.push("Error: " + summary.error);
  if (summary.checkpoint) lines.push("Checkpointed at step " + summary.steps + "; continue with /state-resume.");
  if (summary.logPath) lines.push("Log: " + summary.logPath);
  if (summary.changedFiles.length) lines.push("Changed files: " + summary.changedFiles.join(", "));
  if (summary.blockers.length) lines.push("Blockers: " + summary.blockers.join("; "));
  if (summary.checks.length) {
    lines.push(
      "Last checks: " + summary.checks.map((c) => "`" + c.command + "` → " + c.code).join("; "),
    );
  }
  lines.push("Steps: " + summary.steps + " of " + summary.maxSteps);
  lines.push("Elapsed: " + duration(summary.elapsedMs));
  lines.push("Tool calls: " + summary.actions + " (" + summary.failedActions + " failed)");
  lines.push(
    "Tokens: " +
      (summary.totals.input + summary.totals.output) +
      " (avg prompt " + summary.avgPromptTokens + ", max " + summary.maxPromptTokens +
      (summary.reasoningTokens ? ", hidden reasoning " + summary.reasoningTokens : "") + ")",
  );
  const text = lines.join("\n");
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS - 1) + "…" : text;
}

export default function (pi: ExtensionAPI) {
  let active: { runId: string; controller: AbortController } | undefined;

  // The step line is the only place a run is visible while it runs, so it shows
  // what the step did (action, target, result) rather than only its shape.
  // Everything wider than that is behind the tool-output expansion key.
  pi.registerEntryRenderer<StepTelemetry>("skill-state-step", (entry, { expanded }, theme) => {
    const t = entry.data;
    if (!t) return undefined;
    const ok = t.resultOk ?? t.actionOk;
    let line =
      theme.fg("dim", "state-run ") +
      theme.fg("accent", String(t.step)) + " " + theme.bold(t.status) + " → " +
      clip(t.actionSummary ?? t.actionType, 64) +
      theme.fg("dim", "  " + tokens(t.input) + "→" + tokens(t.output) + " " + duration(t.durationMs));
    if (t.retries) line += theme.fg("warning", "  rejected " + t.retries + "x");
    if (t.providerRetries) line += theme.fg("warning", "  provider retries " + t.providerRetries);
    // Second line: what came back. Reading it is the whole point of watching a run.
    if (t.resultLine) {
      line += "\n" + (ok ? theme.fg("success", "  ✓ ") : theme.fg("error", "  ✗ ")) +
        theme.fg(ok ? "toolOutput" : "error", t.resultLine);
    }
    const state = [
      t.statusChange,
      t.patchedKeys?.length ? "facts " + t.patchedKeys.join(", ") : undefined,
      t.planLeft ? "plan " + t.planLeft + " left" : undefined,
      t.changedCount ? t.changedCount + " changed" : undefined,
    ].filter(Boolean);
    if (state.length) line += "\n" + theme.fg("dim", "  " + state.join(" · "));
    if (expanded) {
      if (t.reasoningHead) line += "\n" + theme.fg("muted", "  reasoning  " + t.reasoningHead.replace(/\n/g, " "));
      for (const r of t.rejections) line += "\n" + theme.fg("warning", "  rejected: " + r);
      // The first preview line is the result line already shown above it.
      const preview = (t.observationPreview ?? "").split("\n").slice(t.resultLine ? 1 : 0);
      if (preview.length) line += "\n" + preview.map((l) => theme.fg("toolOutput", "  │ " + l)).join("\n");
      line += "\n" + theme.fg("dim",
        "  prompt " + t.promptBytes + " B (state " + t.stateBytes + ", observation " + t.observationBytes + ", open files " + (t.openBytes ?? 0) + "), reply " +
        t.replyChars + " chars" + (t.reasoningTokens ? ", " + tokens(t.reasoningTokens) + " hidden reasoning" : "") +
        (t.cacheRead ? ", " + tokens(t.cacheRead) + " cached" : "") + ", re-reads " + t.reReadCount);
    }
    return new Text(line);
  });

  pi.registerEntryRenderer<RunSummary>("skill-state-run", (entry, { expanded }, theme) => {
    const s = entry.data;
    if (!s) return undefined;
    const rows: Array<[string, string]> = [
      ["status", s.status + (s.outcome ? " (" + s.outcome + ")" : "")],
      ["elapsed", duration(s.elapsedMs ?? 0)],
      ["steps", String(s.steps)],
      ["tool calls", (s.actions ?? 0) + " (" + (s.failedActions ?? 0) + " failed)"],
      ["tokens", (s.totals.input + s.totals.output) + " total (in " + s.totals.input + " / out " + s.totals.output + (s.reasoningTokens ? ", hidden reasoning " + s.reasoningTokens : "") + ")"],
      ["prompt tokens avg/max", s.avgPromptTokens + " / " + s.maxPromptTokens],
      ["prompt bytes min/max", s.minPromptBytes + " / " + s.maxPromptBytes],
      ["re-reads", String(s.reReadCount)],
      ["changed files", s.changedFiles.join(", ") || "none"],
    ];
    const clip = (t: string, n: number) => (expanded || t.length <= n ? t : t.slice(0, n - 1) + "…");
    for (const check of s.checks) rows.push(["check → " + check.code, clip(check.command + "  " + check.summary, 160)]);
    if (s.error) rows.push(["error", s.error]);
    if (s.logPath) rows.push(["log", s.logPath]);
    if (s.blockers.length) rows.push(["blockers", s.blockers.map((b) => clip(b, 160)).join(" | ")]);
    if (s.summary) rows.push(["summary", clip(s.summary, 400)]);
    const width = Math.max(...rows.map(([k]) => k.length));
    let text = theme.bold("SKILL.state run: " + clip(s.objective, 200)) + "\n";
    text += rows.map(([k, v]) => theme.fg("dim", k.padEnd(width)) + "  " + v).join("\n");
    return new Text(text);
  });

  // Last non-completed run, resumable with /state-resume. Also persisted as a
  // "skill-state-checkpoint" entry so it survives a Pi restart.
  let lastCheckpoint: Checkpoint | undefined;

  /** In-memory → this session's entries → newest checkpoint file for this directory. */
  async function findCheckpoint(ctx: ExtensionCommandContext): Promise<Checkpoint | undefined> {
    if (lastCheckpoint) return lastCheckpoint;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "skill-state-checkpoint") return entry.data as Checkpoint;
    }
    const newest = (await listCheckpoints(ctx.cwd))[0];
    return newest ? loadCheckpoint(ctx.cwd, newest.runId) : undefined;
  }

  async function launch(ctx: ExtensionCommandContext, options: Omit<RunOptions, "cwd" | "signal" | "complete" | "onStep" | "onEvent" | "model">) {
    let complete: CompleteFn;
    try {
      complete = await makeComplete(ctx, options.runId);
    } catch (err) {
      ctx.ui.notify(String((err as Error).message ?? err), "error");
      return;
    }
    const log = openRunLog(ctx.cwd, options.runId);
    const controller = new AbortController();
    active = { runId: options.runId, controller };

    const view = {
      runId: options.runId,
      maxSteps: options.maxSteps,
      progress: undefined as StepProgress | undefined,
      last: undefined as StepTelemetry | undefined,
      state: options.resume?.state,
      phaseSince: Date.now(),
    };
    // Repainted on every phase change and once a second, so the elapsed time of
    // a step that takes minutes keeps moving.
    const paint = () =>
      ctx.ui.setWidget("state-run", (_tui, theme) => new Text(widgetLines(view, theme)), { placement: "aboveEditor" });
    const ticker = setInterval(paint, 1000);
    paint();
    ctx.ui.setStatus("state-run", "step " + (options.resume?.state.step ?? 0) + " starting");

    let summary: RunSummary;
    try {
      summary = await run({
        ...options,
        cwd: ctx.cwd,
        signal: controller.signal,
        complete,
        onEvent: log.write,
        model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined,
        onProgress: (progress) => {
          view.progress = progress;
          view.phaseSince = Date.now();
          paint();
          ctx.ui.setStatus(
            "state-run",
            "step " + progress.step + "/" + options.maxSteps + " " + progress.status + " " +
              (progress.phase === "thinking" ? "thinking" + (progress.attempt > 1 ? " (attempt " + progress.attempt + ")" : "") : progress.actionSummary),
          );
        },
        onStep: (telemetry, state) => {
          pi.appendEntry("skill-state-step", telemetry);
          view.last = telemetry;
          view.state = state;
          paint();
        },
      });
    } finally {
      active = undefined;
      clearInterval(ticker);
      ctx.ui.setWidget("state-run", undefined);
      ctx.ui.setStatus("state-run", undefined);
    }

    lastCheckpoint = summary.checkpoint;
    if (summary.checkpoint) {
      pi.appendEntry("skill-state-checkpoint", summary.checkpoint);
      await saveCheckpoint(ctx.cwd, summary.checkpoint);
    } else {
      await removeCheckpoint(ctx.cwd, options.runId);
    }
    summary.logPath = log.path;
    pi.appendEntry("skill-state-run", { ...summary, checkpoint: undefined });
    pi.sendMessage(
      { customType: "skill-state-result", content: resultMessage(summary), display: true },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    const tokens = summary.totals.input + summary.totals.output;
    const cost = duration(summary.elapsedMs) + ", " + tokens + " tokens, " + summary.actions + " tool calls (" + summary.failedActions + " failed)";
    if (summary.status === "completed") {
      ctx.ui.notify("state-run completed: " + summary.steps + " steps, " + cost, "info");
    } else {
      ctx.ui.notify(
        "state-run " + summary.status + " at step " + summary.steps + " (" + cost + "). " +
          "Checkpoint " + summary.runId + " saved: switch model if needed, then /state-resume [--max-steps N] [note]",
        "warning",
      );
    }
  }

  pi.registerEntryRenderer<Checkpoint>("skill-state-checkpoint", (entry, _options, theme) => {
    const c = entry.data;
    if (!c) return undefined;
    return new Text(
      theme.fg("dim", "state-run checkpoint ") + "step " + c.state.step + " " + theme.bold(c.state.status) +
        theme.fg("dim", "  resume with /state-resume"),
    );
  });

  pi.registerCommand("state-run", {
    description: "Run an objective with the SKILL.state runtime: /state-run [--skill <path>] [--max-steps N] <objective>",
    handler: async (args, ctx) => {
      if (active) {
        ctx.ui.notify("A state-run is already active; use /state-cancel first", "warning");
        return;
      }
      let parsed: ParsedArgs;
      let spec: string;
      try {
        parsed = parseArgs(args);
        if (!parsed.objective) throw new Error("usage: /state-run [--skill <path>] [--max-steps N] <objective>");
        spec = await loadSpec(parsed.skill, ctx.cwd);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message ?? err), "error");
        return;
      }
      await launch(ctx, {
        runId: "sr-" + Date.now().toString(36),
        objective: await expandObjective(parsed.objective, ctx.cwd),
        spec,
        maxSteps: parsed.maxSteps,
        requireReasoning: parsed.requireReasoning,
        tools: parsed.tools ? toolRunner(ctx) : undefined,
      });
    },
  });

  pi.registerCommand("state-resume", {
    description:
      "Continue a failed or cancelled /state-run from its checkpoint with the current model: " +
      "/state-resume [--list] [--run <runId>] [--max-steps N] [--reasoning required] [--tools] [note for the model]",
    handler: async (args, ctx) => {
      if (/(^|\s)--list(\s|$)/.test(args)) {
        const infos = await listCheckpoints(ctx.cwd);
        if (!infos.length) {
          ctx.ui.notify("No checkpointed state-runs for " + ctx.cwd, "info");
          return;
        }
        const lines = infos.map(
          (c) =>
            c.runId + "  step " + c.step + " " + c.status + "  " + c.savedAt.toISOString().slice(0, 16) +
            "  " + (c.objective.length > 70 ? c.objective.slice(0, 69) + "…" : c.objective),
        );
        pi.sendMessage(
          { customType: "skill-state-list", content: "Checkpointed state-runs (newest first):\n" + lines.join("\n"), display: true },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
        ctx.ui.notify(infos.length + " checkpoint(s); newest " + infos[0].runId + ". Resume with /state-resume --run <runId>", "info");
        return;
      }
      if (active) {
        ctx.ui.notify("A state-run is already active; use /state-cancel first", "warning");
        return;
      }
      const runFlag = /--run\s+(\S+)/.exec(args);
      const checkpoint = runFlag ? await loadCheckpoint(ctx.cwd, runFlag[1]) : await findCheckpoint(ctx);
      if (!checkpoint) {
        ctx.ui.notify(
          runFlag ? "No checkpoint " + runFlag[1] + " for this directory; see /state-resume --list" : "No checkpointed state-run for this directory",
          "info",
        );
        return;
      }
      const flag = /--max-steps\s+(\d+)/.exec(args);
      const maxSteps = flag ? Number(flag[1]) : checkpoint.maxSteps;
      const requireReasoning = /--reasoning\s+required/.test(args);
      const withTools = /(^|\s)--tools(\s|$)/.test(args);
      const note = args
        .replace(/--max-steps\s+\d+/, "")
        .replace(/--run\s+\S+/, "")
        .replace(/--reasoning\s+\S+/, "")
        .replace(/(^|\s)--tools(?=\s|$)/, "")
        .trim();
      if (checkpoint.outcome === "cannot_complete" && !note && maxSteps <= checkpoint.maxSteps) {
        ctx.ui.notify(
          "Run " + checkpoint.runId + " ended with cannot_complete. Resuming the same state unchanged repeats that answer: " +
            "add a note answering its blockers (/state-resume <note>) or a larger --max-steps.",
          "warning",
        );
        return;
      }
      if (checkpoint.state.step >= maxSteps) {
        ctx.ui.notify(
          "Checkpoint is at step " + checkpoint.state.step + "; pass --max-steps larger than that to continue",
          "error",
        );
        return;
      }
      await launch(ctx, {
        runId: checkpoint.runId,
        objective: checkpoint.objective,
        spec: checkpoint.spec,
        maxSteps,
        resume: checkpoint,
        resumeNote: note || undefined,
        requireReasoning,
        tools: withTools ? toolRunner(ctx) : undefined,
      });
    },
  });

  pi.registerCommand("state-log", {
    description: "Show where state-run logs live and list the runs for this directory: /state-log [runId]",
    handler: async (args, ctx) => {
      const dir = runLogDir(ctx.cwd);
      const runs = listRunLogs(ctx.cwd);
      const wanted = args.trim();
      const chosen = wanted ? runs.find((r) => r.runId === wanted) : undefined;
      if (wanted && !chosen) {
        ctx.ui.notify("No log for run " + wanted + " in " + dir, "warning");
        return;
      }
      const tool = "bun extensions/skill-state/tools/runlog.ts";
      const lines = ["state-run logs for this directory: " + dir, ""];
      if (chosen) {
        lines.push(chosen.runId + "  " + chosen.steps + " steps  " + chosen.outcome, chosen.path, "");
        lines.push("Inspect: " + tool + " " + chosen.runId + " [--rejections | --step N [--prompt|--reply]]  (run from the plugin repo, add --cwd " + ctx.cwd + ")");
      } else if (!runs.length) {
        lines.push("No runs logged yet. Every /state-run writes <runId>.jsonl here as it goes.");
      } else {
        for (const r of runs.slice(0, 20)) {
          lines.push(
            r.runId + "  " + r.modified.toISOString().slice(0, 16) + "  " + r.steps + " steps  " + r.outcome +
              "  " + (r.objective.length > 60 ? r.objective.slice(0, 59) + "…" : r.objective),
          );
        }
        if (runs.length > 20) lines.push("… " + (runs.length - 20) + " more");
        lines.push("", "Inspect: " + tool + " <runId>  (run from the plugin repo, add --cwd " + ctx.cwd + "); /state-log <runId> for one path");
      }
      pi.sendMessage(
        { customType: "skill-state-log", content: lines.join("\n"), display: true },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      ctx.ui.notify(chosen ? chosen.path : runs.length + " run log(s) in " + dir, "info");
    },
  });

  pi.registerCommand("state-cancel", {
    description: "Cancel the active /state-run",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No active state-run", "info");
        return;
      }
      active.controller.abort();
      ctx.ui.notify("Cancelling state-run " + active.runId, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    active?.controller.abort();
  });
}
