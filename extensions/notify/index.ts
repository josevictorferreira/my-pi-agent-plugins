import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

/** Env accessors — the contract lives in README.md. */
const NOTIFY_ENABLED = () => {
	const raw = (process.env.NOTIFY_ENABLED || "1").toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "off");
};
const NOTIFY_COMMAND = () => process.env.NOTIFY_COMMAND || "notify-send";
const NOTIFY_TITLE = () => process.env.NOTIFY_TITLE || "pi";

export type Outcome = "success" | "error" | "question" | "skip";

/** What kind of notification does this settled run warrant? */
export function classify(msg: { stopReason: string; text: string }): Outcome {
	if (msg.stopReason === "error") return "error";
	if (msg.stopReason === "aborted") return "skip";
	const lastLine = msg.text.trim().split("\n").filter(Boolean).at(-1) ?? "";
	if (lastLine.trimEnd().endsWith("?")) return "question";
	return "success";
}

/** Last non-empty line of a reply. */
function lastLine(text: string): string {
	return text.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

/** One-line teaser body: newlines collapse to spaces, capped length. */
function teaser(text: string, max = 200): string {
	return text.replace(/\s*\n\s*/g, " ").trim().slice(0, max);
}

/** `pi (my-project): done` — prefix from NOTIFY_TITLE, project dir when available. */
function titleFor(kind: string): string {
	const dir = basename(process.cwd()) || undefined;
	const prefix = dir ? `${NOTIFY_TITLE()} (${dir})` : NOTIFY_TITLE();
	return `${prefix}: ${kind}`;
}

/** Map an outcome to the notification title/body and the notify-send argv. */
export function buildNotification(
	outcome: Exclude<Outcome, "skip">,
	msg: { stopReason: string; text: string; errorMessage?: string },
): { title: string; body: string; args: string[] } {
	const kind = outcome === "success" ? "done" : outcome;
	const urgency = outcome === "success" ? "low" : outcome === "question" ? "normal" : "critical";
	const icon = `dialog-${outcome === "success" ? "information" : outcome === "question" ? "question" : "error"}`;
	const expireMs = outcome === "success" ? 5000 : 0;
	const category = outcome === "error" ? "im.error" : "im";
	const body =
		outcome === "error"
			? teaser(msg.errorMessage || msg.stopReason)
			: outcome === "question"
				? teaser(lastLine(msg.text))
				: teaser(msg.text);
	const title = titleFor(kind);
	const args = [
		"--app-name",
		"pi",
		"--icon",
		icon,
		"--urgency",
		urgency,
		"--expire-time",
		String(expireMs),
		"--category",
		category,
		title,
		body,
	];
	return { title, body, args };
}

/** Text blocks of a message, joined. Handles string and block-array content. */
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

/** Latest assistant message on the current branch, or undefined. */
function lastAssistantMessage(
	ctx: ExtensionContext,
): { id: string; text: string; stopReason: string; errorMessage?: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry: any = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = messageText(entry.message);
		const stopReason = typeof entry.message.stopReason === "string" ? entry.message.stopReason : "stop";
		if (!text && stopReason !== "error") continue;
		return {
			id: entry.id ?? text,
			text,
			stopReason,
			errorMessage: typeof entry.message.errorMessage === "string" ? entry.message.errorMessage : undefined,
		};
	}
	return undefined;
}

// Fire-and-forget bookkeeping: dedupe by assistant message id + one-time failure warning.
// Reset on session_start so a resumed/new session behaves fresh.
let lastNotifiedId: string | undefined;
let warned = false;

/** Warn once per session, only when there is a UI to show it. */
function warnOnce(ctx: ExtensionContext, detail: string): void {
	if (warned) return;
	warned = true;
	if (ctx.hasUI) ctx.ui?.notify(`notify: ${detail}`, "warning");
}

/** Send the notification for one settled run. Never throws. */
async function notifySettled(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!NOTIFY_ENABLED()) return;
	const msg = lastAssistantMessage(ctx);
	if (!msg || msg.id === lastNotifiedId) return;
	const outcome = classify(msg);
	if (outcome === "skip") return; // aborted — the user is present
	lastNotifiedId = msg.id;
	const { args } = buildNotification(outcome, msg);
	try {
		const result = await pi.exec(NOTIFY_COMMAND(), args, { timeout: 5000 });
		if (result.code !== 0) warnOnce(ctx, `${NOTIFY_COMMAND()} exited with code ${result.code}`);
	} catch (error) {
		warnOnce(ctx, `failed to run ${NOTIFY_COMMAND()}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", (_event, ctx) => {
		void notifySettled(pi, ctx).catch(() => {});
	});
	pi.on("session_start", () => {
		lastNotifiedId = undefined;
		warned = false;
	});
}
