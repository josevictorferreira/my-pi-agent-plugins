import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_MAX_STEPS, run, type Checkpoint, type CompleteFn, type RunOptions, type RunSummary, type StepTelemetry } from "./runner";
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
}

/** `/state-run [--skill <path>] [--max-steps N] <objective>` */
function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let skill: string | undefined;
  let maxSteps = DEFAULT_MAX_STEPS;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--skill" && tokens[i + 1]) skill = tokens[++i];
    else if (token === "--max-steps" && tokens[i + 1]) {
      const n = Number.parseInt(tokens[++i], 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("--max-steps must be a positive integer");
      maxSteps = n;
    } else rest.push(token);
  }
  return { objective: rest.join(" "), skill, maxSteps };
}

/**
 * Bind the session model to the runner's `complete` contract: auth resolved once
 * per run, optional temperature, no `reasoning` option so provider thinking stays off.
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
    return { text, usage: { input: reply.usage.input, output: reply.usage.output, cacheRead: reply.usage.cacheRead } };
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
  if (summary.changedFiles.length) lines.push("Changed files: " + summary.changedFiles.join(", "));
  if (summary.blockers.length) lines.push("Blockers: " + summary.blockers.join("; "));
  if (summary.checks.length) {
    lines.push(
      "Last checks: " + summary.checks.map((c) => "`" + c.command + "` → " + c.code).join("; "),
    );
  }
  lines.push(
    "Tokens: " +
      (summary.totals.input + summary.totals.output) +
      " (avg prompt " + summary.avgPromptTokens + ", max " + summary.maxPromptTokens + ")",
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
      theme.fg("dim", "  prompt " + t.promptBytes + " B, in " + t.input + " / out " + t.output);
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
      ["tokens in/out", s.totals.input + " / " + s.totals.output],
      ["prompt tokens avg/max", s.avgPromptTokens + " / " + s.maxPromptTokens],
      ["prompt bytes min/max", s.minPromptBytes + " / " + s.maxPromptBytes],
      ["re-reads", String(s.reReadCount)],
      ["changed files", s.changedFiles.join(", ") || "none"],
    ];
    if (s.error) rows.push(["error", s.error]);
    const width = Math.max(...rows.map(([k]) => k.length));
    let text = theme.bold("SKILL.state run: " + s.objective) + "\n";
    text += rows.map(([k, v]) => theme.fg("dim", k.padEnd(width)) + "  " + v).join("\n");
    if (expanded && s.summary) text += "\n" + s.summary;
    return new Text(text);
  });

  // Last non-completed run, resumable with /state-resume. Also persisted as a
  // "skill-state-checkpoint" entry so it survives a Pi restart.
  let lastCheckpoint: Checkpoint | undefined;

  function findCheckpoint(ctx: ExtensionCommandContext): Checkpoint | undefined {
    if (lastCheckpoint) return lastCheckpoint;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "skill-state-checkpoint") return entry.data as Checkpoint;
    }
    return undefined;
  }

  async function launch(ctx: ExtensionCommandContext, options: Omit<RunOptions, "cwd" | "signal" | "complete" | "onStep">) {
    let complete: CompleteFn;
    try {
      complete = await makeComplete(ctx);
    } catch (err) {
      ctx.ui.notify(String((err as Error).message ?? err), "error");
      return;
    }
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
    if (summary.checkpoint) pi.appendEntry("skill-state-checkpoint", summary.checkpoint);
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
          "State is checkpointed: switch model if needed, then /state-resume [--max-steps N]",
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
      });
    },
  });

  pi.registerCommand("state-resume", {
    description: "Continue the last failed or cancelled /state-run from its checkpointed state, with the current model: /state-resume [--max-steps N]",
    handler: async (args, ctx) => {
      if (active) {
        ctx.ui.notify("A state-run is already active; use /state-cancel first", "warning");
        return;
      }
      const checkpoint = findCheckpoint(ctx);
      if (!checkpoint) {
        ctx.ui.notify("No checkpointed state-run in this session", "info");
        return;
      }
      const flag = /--max-steps\s+(\d+)/.exec(args);
      const maxSteps = flag ? Number(flag[1]) : checkpoint.maxSteps;
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
      });
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
