import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_MAX_STEPS, run, type Checkpoint, type CompleteFn, type RunOptions, type RunSummary, type StepTelemetry } from "./runner";
import { listCheckpoints, loadCheckpoint, removeCheckpoint, saveCheckpoint } from "./checkpoints";
import { listRunLogs, openRunLog, runLogDir } from "./runlog";
import { hasStateRunTool, listStateRunTools, runStateRunTool, validateToolParams } from "./tool-registry";
import { loadSpec } from "./workflow";

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
  noTools: boolean;
}

/** `/state-run [--skill <path>] [--max-steps N] [--reasoning required|optional] [--no-tools] <objective>` */
export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let skill: string | undefined;
  let maxSteps = DEFAULT_MAX_STEPS;
  let requireReasoning = false;
  let noTools = false;
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
    } else if (token === "--no-tools") noTools = true;
    else rest.push(token);
  }
  // An objective typed in quotes would otherwise carry them into every prompt.
  const objective = rest.join(" ").replace(/^["'“]([\s\S]*)["'”]$/, "$1").trim();
  return { objective, skill, maxSteps, requireReasoning, noTools };
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
 * Bind the session model to the runner's `complete` contract: auth resolved once
 * per run, optional temperature, no `reasoning` option. pi-ai sends a provider's
 * "thinking off" form where it knows one; through a generic OpenAI-compatible
 * proxy nothing is sent and the model's default applies (glm-5-3 via Velox spent
 * about five of every six output tokens on hidden reasoning). `usage.reasoning`
 * records it when the provider reports it.
 */
async function makeComplete(ctx: ExtensionCommandContext): Promise<CompleteFn> {
  const model = ctx.model;
  if (!model) throw new Error("no model selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const target = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const temperature = configuredTemperature();
  return async (prompt, signal) => {
    const reply = await complete(
      target,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal, temperature },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage || reply.stopReason);
    }
    const text = reply.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      text,
      usage: { input: reply.usage.input, output: reply.usage.output, cacheRead: reply.usage.cacheRead, reasoning: reply.usage.reasoning },
    };
  };
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

  pi.registerEntryRenderer<StepTelemetry>("skill-state-step", (entry, { expanded }, theme) => {
    const t = entry.data;
    if (!t) return undefined;
    let line =
      theme.fg("dim", "state-run ") +
      "step " + t.step + " " + theme.bold(t.status) + " → " + t.actionType +
      theme.fg("dim", "  prompt " + t.promptBytes + " B, in " + t.input + " / out " + t.output +
        (t.reasoningTokens !== undefined ? " (" + t.reasoningTokens + " reasoning)" : ""));
    if (t.retries) line += theme.fg("warning", "  rejected " + t.retries + "x");
    if (t.providerRetries) line += theme.fg("warning", "  provider retries " + t.providerRetries);
    if (expanded) {
      for (const r of t.rejections) line += "\n" + theme.fg("warning", "  rejected: " + r);
      line += "\n" + theme.fg("dim", JSON.stringify(t, null, 2));
    }
    return new Text(line);
  });

  pi.registerEntryRenderer<RunSummary>("skill-state-run", (entry, { expanded }, theme) => {
    const s = entry.data;
    if (!s) return undefined;
    const rows: Array<[string, string]> = [
      ["status", s.status + (s.outcome ? " (" + s.outcome + ")" : "")],
      ["steps", String(s.steps)],
      ["tokens in/out", s.totals.input + " / " + s.totals.output + (s.reasoningTokens ? " (hidden reasoning " + s.reasoningTokens + ")" : "")],
      ["prompt tokens avg/max", s.avgPromptTokens + " / " + s.maxPromptTokens],
      ["prompt bytes min/max", s.minPromptBytes + " / " + s.maxPromptBytes],
      ["re-reads", String(s.reReadCount)],
      ["changed files", s.changedFiles.join(", ") || "none"],
    ];
    if (s.error) rows.push(["error", s.error]);
    if (s.logPath) rows.push(["log", s.logPath]);
    const clip = (t: string, n: number) => (expanded || t.length <= n ? t : t.slice(0, n - 1) + "…");
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
      complete = await makeComplete(ctx);
    } catch (err) {
      ctx.ui.notify(String((err as Error).message ?? err), "error");
      return;
    }
    const log = openRunLog(ctx.cwd, options.runId);
    const controller = new AbortController();
    active = { runId: options.runId, controller };
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
        onStep: (telemetry) => {
          pi.appendEntry("skill-state-step", telemetry);
          ctx.ui.setStatus("state-run", "step " + telemetry.step + " " + telemetry.status + " " + telemetry.actionType);
        },
      });
    } finally {
      active = undefined;
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
    if (summary.status === "completed") {
      ctx.ui.notify("state-run completed: " + summary.steps + " steps, " + tokens + " tokens", "info");
    } else {
      ctx.ui.notify(
        "state-run " + summary.status + " at step " + summary.steps + " (" + tokens + " tokens). " +
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
        objective: parsed.objective,
        spec,
        maxSteps: parsed.maxSteps,
        requireReasoning: parsed.requireReasoning,
        tools: parsed.noTools ? undefined : toolRunner(ctx),
      });
    },
  });

  pi.registerCommand("state-resume", {
    description:
      "Continue a failed or cancelled /state-run from its checkpoint with the current model: " +
      "/state-resume [--list] [--run <runId>] [--max-steps N] [--reasoning required] [--no-tools] [note for the model]",
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
      const noTools = /(^|\s)--no-tools(\s|$)/.test(args);
      const note = args
        .replace(/--max-steps\s+\d+/, "")
        .replace(/--run\s+\S+/, "")
        .replace(/--reasoning\s+\S+/, "")
        .replace(/(^|\s)--no-tools(?=\s|$)/, "")
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
        tools: noTools ? undefined : toolRunner(ctx),
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
