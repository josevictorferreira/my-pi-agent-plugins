#!/usr/bin/env bun
/**
 * Drive one SKILL.state run from a shell, without Pi, so runs can be scripted
 * and compared: same runner, same prompts, same actions as /state-run; only
 * the model binding is built here from a Pi catalog file and an API key.
 *
 *   bun extensions/skill-state/tools/bench.ts --cwd <repo> --model <provider/id> <objective>
 *       [--thinking off|minimal|low|medium|high|unset]  session thinking level (default off; unset sends nothing)
 *       [--max-steps N] [--skill <path>]
 *       [--models-store <path>]   Pi's models-store.json (default $PI_CODING_AGENT_DIR or ~/.pi/agent), else the built-in catalog
 *       [--api-key-env NAME]      env var holding the key (default OPENROUTER_API_KEY for openrouter, <PROVIDER>_API_KEY otherwise)
 *       [--log <path>]            per-run JSONL trace (same records as the Pi log)
 *
 * One line per step on stderr; the run summary as JSON on stdout, with the cost
 * estimated from the catalog prices.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModel, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import { bindModel } from "../model";
import { DEFAULT_MAX_STEPS, run, type RunEvent } from "../runner";
import { expandObjective, loadSpec } from "../workflow";

interface Args {
  cwd: string;
  model: string;
  objective: string;
  thinking?: ModelThinkingLevel;
  maxSteps: number;
  skill?: string;
  modelsStore?: string;
  apiKeyEnv?: string;
  log?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd(), model: "", objective: "", thinking: "off", maxSteps: DEFAULT_MAX_STEPS };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(a + " needs a value");
      return argv[++i];
    };
    if (a === "--cwd") args.cwd = next();
    else if (a === "--model") args.model = next();
    else if (a === "--thinking") {
      const v = next();
      args.thinking = v === "unset" ? undefined : (v as ModelThinkingLevel);
    } else if (a === "--max-steps") args.maxSteps = Number(next());
    else if (a === "--skill") args.skill = next();
    else if (a === "--models-store") args.modelsStore = next();
    else if (a === "--api-key-env") args.apiKeyEnv = next();
    else if (a === "--log") args.log = next();
    else rest.push(a);
  }
  args.objective = rest.join(" ").trim();
  if (!args.model || !args.objective) throw new Error("usage: bench.ts --cwd <repo> --model <provider/id> [options] <objective>");
  return args;
}

/** The catalog entry for provider/id, from a Pi models-store.json or the built-in catalog. */
function resolveModel(spec: string, storePath: string | undefined): Model<any> {
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error("--model must be <provider>/<id>");
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const candidates = [storePath, join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models-store.json")].filter(Boolean) as string[];
  for (const path of candidates) {
    let store: Record<string, { models?: Model<any>[] }>;
    try {
      store = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const found = store[provider]?.models?.find((m) => m.id === id);
    if (found) return found;
  }
  const builtin = (getModel as (p: string, i: string) => Model<any> | undefined)(provider, id);
  if (!builtin) throw new Error("model " + spec + " not in " + candidates.join(", ") + " nor the built-in catalog");
  return builtin;
}

function apiKeyFor(model: Model<any>, envName: string | undefined): string {
  const name = envName ?? (model.provider === "openrouter" ? "OPENROUTER_API_KEY" : model.provider.toUpperCase().replace(/-/g, "_") + "_API_KEY");
  const key = process.env[name];
  if (!key) throw new Error("no API key: set " + name + " or pass --api-key-env");
  return key;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const model = resolveModel(args.model, args.modelsStore);
  const apiKey = apiKeyFor(model, args.apiKeyEnv);
  const spec = await loadSpec(args.skill, args.cwd);
  const runId = "bench-" + Date.now().toString(36);
  const complete = bindModel(model, { apiKey }, { runId, thinking: args.thinking });
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const onEvent = args.log ? (event: RunEvent) => appendFileSync(args.log!, JSON.stringify(event) + "\n") : undefined;

  const summary = await run({
    runId,
    objective: await expandObjective(args.objective, args.cwd),
    spec,
    cwd: args.cwd,
    maxSteps: args.maxSteps,
    signal: controller.signal,
    complete,
    onEvent,
    model: model.provider + "/" + model.id,
    onStep: (t) => {
      process.stderr.write(
        [
          String(t.step).padStart(3),
          t.status.padEnd(10),
          t.actionSummary.slice(0, 70).padEnd(70),
          "in=" + t.input,
          "out=" + t.output,
          t.reasoningTokens !== undefined ? "rsn=" + t.reasoningTokens : "",
          "cache=" + t.cacheRead,
          t.retries ? "rejected=" + t.retries : "",
          Math.round(t.durationMs / 100) / 10 + "s",
        ]
          .filter(Boolean)
          .join(" ") + "\n",
      );
    },
  });

  const cost = model.cost
    ? (summary.totals.input * model.cost.input + summary.totals.output * model.cost.output + summary.totals.cacheRead * (model.cost.cacheRead ?? 0)) / 1e6
    : undefined;
  process.stdout.write(JSON.stringify({ ...summary, checkpoint: undefined, thinking: args.thinking ?? "unset", estimatedCostUsd: cost }, null, 2) + "\n");
  process.exit(summary.status === "completed" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(String((err as Error).stack ?? err) + "\n");
  process.exit(2);
});
