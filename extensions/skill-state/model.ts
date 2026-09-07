import { completeSimple, type Model, type ModelThinkingLevel, type ProviderHeaders, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { CompleteFn } from "./runner";

export interface ModelAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
}

export interface BindOptions {
  /** Cache session key (the run id). */
  runId: string;
  /**
   * Provider thinking for the run. "off" is sent as an explicit disable;
   * undefined leaves the request untouched, so the model's own default applies.
   */
  thinking?: ModelThinkingLevel;
  temperature?: number;
}

const OPENROUTER_FORMAT = (model: Model<any>): boolean =>
  (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat === "openrouter" || (model.baseUrl ?? "").includes("openrouter.ai");

/**
 * Bind a model to the runner's `complete` contract.
 *
 * The spec, action vocabulary and state rules go in the system prompt and the
 * run id is the cache session key, so the part that never changes between
 * steps can be served from the provider's prompt cache where the provider
 * caches prefixes that short (`cacheRead` in the telemetry is the measurement).
 *
 * Thinking: pi-ai sends OpenRouter's "reasoning off" form only when the catalog
 * says the model can turn reasoning off. For inception/mercury-2.5-preview the
 * catalog says it cannot (thinkingLevelMap.off is null), so nothing was sent
 * and the model's default applied: 95k of a run's 105k output tokens were
 * hidden reasoning, about 70 % of its cost. The endpoint accepts
 * `reasoning.enabled = false` all the same and returns zero reasoning tokens,
 * so "off" is enforced on the request when pi-ai left it out.
 */
export function bindModel(model: Model<any>, auth: ModelAuth, options: BindOptions): CompleteFn {
  const { thinking } = options;
  const reasoning = thinking && thinking !== "off" ? thinking : undefined;
  const onPayload =
    thinking === "off" && OPENROUTER_FORMAT(model)
      ? (payload: unknown) => {
          const body = payload as Record<string, unknown>;
          return body.reasoning === undefined ? { ...body, reasoning: { enabled: false } } : undefined;
        }
      : undefined;
  return async (prompt, signal) => {
    const streamOptions: SimpleStreamOptions & Record<string, unknown> = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      temperature: options.temperature,
      cacheRetention: "long",
      sessionId: options.runId,
      reasoning,
      onPayload,
    };
    const reply = await completeSimple(
      model,
      { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] },
      streamOptions,
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
