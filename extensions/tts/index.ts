import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

const DEFAULT_API_URL = "https://velox.josevictor.me";

const TTS_MODEL = () => process.env.TTS_MODEL || "tts-1";
const TTS_VOICE = () => process.env.TTS_VOICE || "geffen_32";
const SUMMARY_MODEL = () => process.env.TTS_SUMMARY_MODEL || "deepseek-v4-flash";
const AUTO_SPEAK = () => /^(1|true|yes|on)$/i.test(process.env.TTS_AUTO_SPEAK || "");

// /v1/audio/speech rejects input above 4096 chars; stay under it.
const MAX_SPEECH_CHARS = 4000;

// Skip the summarizer round-trip for short, code-free replies.
const DIRECT_SPEAK_MAX_CHARS = 300;

const SUMMARY_PROMPT =
  "Summarize the assistant message below for text-to-speech in 2-3 plain " +
  "spoken sentences. No markdown, no code, no lists, no file paths.";

function apiUrl(): string {
  return (process.env.VELOX_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** POST a JSON body to a Velox endpoint. Returns the Response or throws a string. */
async function veloxFetch(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const key = process.env.VELOX_API_KEY;
  if (!key) throw "VELOX_API_KEY is not set";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + key,
  };

  let response: Response;
  try {
    response = await fetch(apiUrl() + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw "aborted";
    throw "request failed: " + String(err);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    // Errors come back as an OpenAI-shaped { error: { message } } envelope.
    let message = errText;
    try {
      message = JSON.parse(errText)?.error?.message || errText;
    } catch {
      // Not JSON — relay the raw body.
    }
    throw "HTTP " + response.status + ": " + message;
  }
  return response;
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

/** Latest assistant text on the current branch, or undefined. */
function lastAssistantText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry: any = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const text = messageText(entry.message);
      if (text) return text;
    }
  }
  return undefined;
}

/** Ask Velox for a short spoken-style summary of the reply. */
async function summarize(text: string, signal: AbortSignal): Promise<string> {
  if (text.length <= DIRECT_SPEAK_MAX_CHARS && !text.includes("```")) {
    return text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_`#>]|\[|\]\([^)]*\)/g, "")
      .trim();
  }

  const response = await veloxFetch(
    "/v1/chat/completions",
    {
      model: SUMMARY_MODEL(),
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: text.slice(0, 20000) },
      ],
      max_tokens: 200,
    },
    signal,
  );
  const data: any = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw "summarizer returned no text";
  return content.trim().slice(0, MAX_SPEECH_CHARS);
}

/** Convert text to mp3 audio bytes via Velox. */
async function synthesize(input: string, signal: AbortSignal): Promise<Buffer> {
  const response = await veloxFetch(
    "/v1/audio/speech",
    {
      model: TTS_MODEL(),
      input,
      voice: TTS_VOICE(),
      response_format: "mp3",
    },
    signal,
  );
  return Buffer.from(await response.arrayBuffer());
}

async function canExecute(bin: string): Promise<boolean> {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      await access(join(dir, bin), 1); // X_OK
      return true;
    } catch {
      // Not in this dir — keep looking.
    }
  }
  return false;
}

const PLAYER_ARGS: Record<string, string[]> = {
  mpv: ["--no-video", "--really-quiet"],
  ffplay: ["-nodisp", "-autoexit", "-loglevel", "quiet"],
  "pw-play": [],
};

/** Resolve the player command: TTS_PLAYER override, else first available. */
async function findPlayer(): Promise<{ cmd: string; args: string[] }> {
  const override = process.env.TTS_PLAYER;
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw "TTS_PLAYER is set but empty";
    return { cmd: parts[0], args: parts.slice(1) };
  }
  for (const bin of Object.keys(PLAYER_ARGS)) {
    if (await canExecute(bin)) return { cmd: bin, args: PLAYER_ARGS[bin] };
  }
  throw "no audio player found (tried mpv, ffplay, pw-play)";
}

/** Play an audio file; resolves on close; killed on abort. */
function play(file: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    findPlayer()
      .then(({ cmd, args }) => {
        const child = spawn(cmd, args.concat(file), { stdio: "ignore" });
        const onAbort = () => child.kill("SIGTERM");
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => {
          signal.removeEventListener("abort", onAbort);
          reject("player " + cmd + " failed to start: " + String(err));
        });
        child.on("close", () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      })
      .catch(reject);
  });
}

// --- Session-scoped run state -----------------------------------------------

let current: { controller: AbortController; file: string } | undefined;
let runSeq = 0;

function stopCurrent(): void {
  if (!current) return;
  current.controller.abort();
}

/** Manual trigger: speak the last reply, or stop if already speaking. */
async function speakLastMessage(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return; // print/json modes: no-op

  // A second invocation stops whatever is playing instead of queueing.
  if (current) {
    stopCurrent();
    ctx.ui.notify("tts: stopped", "info");
    return;
  }

  await startSpeaking(ctx);
}

/** Auto trigger: a new reply supersedes anything still playing. */
async function autoSpeak(ctx: ExtensionContext): Promise<void> {
  if (!AUTO_SPEAK() || !ctx.hasUI) return;
  stopCurrent();
  await startSpeaking(ctx);
}

async function startSpeaking(ctx: ExtensionContext): Promise<void> {
  const text = lastAssistantText(ctx);
  if (!text) {
    ctx.ui.notify("tts: no assistant message yet", "warning");
    return;
  }

  const controller = new AbortController();
  // Unique per run so a superseded run's cleanup can't delete the new file.
  const file = join(tmpdir(), "pi-tts-" + process.pid + "-" + ++runSeq + ".mp3");
  const run = { controller, file };
  current = run;

  try {
    ctx.ui.setStatus("tts", "summarizing…");
    const summary = await summarize(text, controller.signal);

    ctx.ui.setStatus("tts", "synthesizing…");
    const audio = await synthesize(summary, controller.signal);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, audio);

    ctx.ui.setStatus("tts", "▶ speaking");
    await play(file, controller.signal);
  } catch (err) {
    if (String(err) !== "aborted" && !controller.signal.aborted) {
      ctx.ui.notify("tts: " + String(err), "error");
    }
  } finally {
    await unlink(file).catch(() => {});
    // Only the active run owns the shared state; a superseded run must not clobber it.
    if (current === run) {
      current = undefined;
      ctx.ui.setStatus("tts", undefined);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("speak", {
    description: "Summarize the last agent reply and play it as speech (again: stop)",
    handler: async (_args, ctx) => speakLastMessage(ctx),
  });

  pi.registerShortcut("ctrl+alt+s", {
    description: "Speak summary of last agent reply",
    handler: (ctx) => speakLastMessage(ctx),
  });

  pi.on("agent_settled", (_event, ctx) => autoSpeak(ctx));

  pi.on("session_shutdown", () => stopCurrent());
}
