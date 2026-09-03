import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_MAX_STEPS, run, type CompleteFn, type RunSummary, type StepTelemetry } from "./runner";
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
    if (t.retries) line += theme.fg("warning", "  retries " + t.retries);
    if (expanded) line += "\n" + theme.fg("dim", JSON.stringify(t, null, 2));
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

  pi.registerCommand("state-run", {
    description: "Run an objective with the SKILL.state runtime: /state-run [--skill <path>] [--max-steps N] <objective>",
    handler: async (args, ctx) => {
      if (active) {
        ctx.ui.notify("A state-run is already active; use /state-cancel first", "warning");
        return;
      }
      let parsed: ParsedArgs;
      let spec: string;
      let complete: CompleteFn;
      try {
        parsed = parseArgs(args);
        if (!parsed.objective) throw new Error("usage: /state-run [--skill <path>] [--max-steps N] <objective>");
        spec = await loadSpec(parsed.skill, ctx.cwd);
        complete = await makeComplete(ctx);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message ?? err), "error");
        return;
      }

      const runId = "sr-" + Date.now().toString(36);
      const controller = new AbortController();
      active = { runId, controller };
      ctx.ui.setStatus("state-run", "step 0 starting");

      let summary: RunSummary;
      try {
        summary = await run({
          runId,
          objective: parsed.objective,
          spec,
          cwd: ctx.cwd,
          maxSteps: parsed.maxSteps,
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

      pi.appendEntry("skill-state-run", summary);
      pi.sendMessage(
        { customType: "skill-state-result", content: resultMessage(summary), display: true },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      ctx.ui.notify(
        "state-run " + summary.status + ": " + summary.steps + " steps, " +
          (summary.totals.input + summary.totals.output) + " tokens",
        summary.status === "completed" ? "info" : "warning",
      );
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
