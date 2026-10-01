import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readInboxFrom, readTask, updateTask, writeResult } from "./state";

// Child role: active only inside a subagent process (PI_SUBAGENT_TASK set).
// Talks to the launcher exclusively through the task files: status and the
// final text of every settled turn go out, follow-up messages come in through
// the inbox. The child never knows whether its parent is still alive.

const INBOX_POLL_MS = 1500;

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

/** Latest assistant message on the current branch (same walk as notify/tts). */
function lastAssistantMessage(ctx: ExtensionContext): { text: string; stopReason: string; errorMessage?: string } | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry: any = branch[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = messageText(entry.message);
    const stopReason = typeof entry.message.stopReason === "string" ? entry.message.stopReason : "stop";
    if (!text && stopReason !== "error") continue;
    return {
      text,
      stopReason,
      errorMessage: typeof entry.message.errorMessage === "string" ? entry.message.errorMessage : undefined,
    };
  }
  return undefined;
}

export function registerChild(pi: ExtensionAPI, taskId: string, rootSessionId: string): void {
  let current: ExtensionContext | undefined;
  let inboxOffset = 0;
  let inboxTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;

  const patch = (ctx: ExtensionContext, fields: Parameters<typeof updateTask>[3]) =>
    updateTask(ctx.cwd, rootSessionId, taskId, fields);

  async function pollInbox(): Promise<void> {
    const ctx = current;
    if (!ctx || polling) return;
    polling = true;
    try {
      const { entries, offset } = await readInboxFrom(ctx.cwd, rootSessionId, taskId, inboxOffset);
      inboxOffset = offset;
      let busy = !ctx.isIdle();
      for (const entry of entries) {
        await pi.sendUserMessage(entry.text, busy ? { deliverAs: "followUp" } : undefined);
        busy = true;
      }
    } catch {
      // the inbox is optional; a transient read error is retried next tick
    } finally {
      polling = false;
    }
  }

  /** Switch to the fallback model after a provider error; true when a retry was started. */
  async function tryFallback(ctx: ExtensionContext, errorMessage: string | undefined): Promise<boolean> {
    const record = await readTask(ctx.cwd, rootSessionId, taskId);
    if (!record?.fallbackModel || record.fellBack) return false;
    const slash = record.fallbackModel.indexOf("/");
    const model = slash > 0
      ? ctx.modelRegistry.find(record.fallbackModel.slice(0, slash), record.fallbackModel.slice(slash + 1))
      : undefined;
    if (!model) {
      await writeResult(ctx.cwd, rootSessionId, taskId,
        "[provider error] " + (errorMessage ?? "unknown error") + "\n\nfallback model " + record.fallbackModel + " not found; no retry.");
      return false;
    }
    if (!(await pi.setModel(model))) return false;
    await patch(ctx, { fellBack: true, model: record.fallbackModel, status: "running" });
    await pi.sendUserMessage(
      "The previous attempt failed with a provider error (" + (errorMessage ?? "unknown error") +
        "). The model was switched; continue the task.",
    );
    return true;
  }

  pi.on("session_start", async (_event, ctx) => {
    current = ctx;
    await patch(ctx, { sessionFile: ctx.sessionManager.getSessionFile(), status: "running" });
    if (!inboxTimer) inboxTimer = setInterval(pollInbox, INBOX_POLL_MS);
  });

  pi.on("agent_start", async (_event, ctx) => {
    current = ctx;
    await patch(ctx, { status: "running" });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    current = ctx;
    const last = lastAssistantMessage(ctx);
    if (last) {
      const text = last.stopReason === "error"
        ? "[provider error] " + (last.errorMessage ?? "unknown error") + (last.text ? "\n\n" + last.text : "")
        : last.text;
      await writeResult(ctx.cwd, rootSessionId, taskId, text);
      if (last.stopReason === "error" && (await tryFallback(ctx, last.errorMessage))) return;
    }
    const record = await readTask(ctx.cwd, rootSessionId, taskId);
    await patch(ctx, { turns: (record?.turns ?? 0) + 1, status: "idle", lastStopReason: last?.stopReason });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (inboxTimer) clearInterval(inboxTimer);
    inboxTimer = undefined;
    const record = await readTask(ctx.cwd, rootSessionId, taskId);
    if (record && !record.closedAt) await patch(ctx, { status: "exited" });
  });
}
