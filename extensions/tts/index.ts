import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { access, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_API_URL = "https://velox.josevictor.me";

const TTS_MODEL = () => process.env.TTS_MODEL || "voice";
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

/** Latest assistant message on the current branch, or undefined. */
function lastAssistantMessage(ctx: ExtensionContext): { id: string; text: string } | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry: any = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const text = messageText(entry.message);
      if (text) return { id: entry.id ?? text, text };
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

/** Convert text to wav audio bytes via Velox. */
async function synthesize(input: string, signal: AbortSignal): Promise<Buffer> {
  const response = await veloxFetch(
    "/v1/audio/speech",
    {
      model: TTS_MODEL(),
      input,
      voice: TTS_VOICE(),
      response_format: "wav",
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

const MAX_CACHE_ENTRIES = 50;
const audioCache = new Map<string, string>();
const sessionFiles = new Set<string>();

function stopCurrent(): void {
  if (!current) return;
  current.controller.abort();
}

async function getCachedAudio(key: string): Promise<string | undefined> {
  const file = audioCache.get(key);
  if (!file) return undefined;
  try {
    await access(file);
    // Refresh LRU order
    audioCache.delete(key);
    audioCache.set(key, file);
    return file;
  } catch {
    audioCache.delete(key);
    sessionFiles.delete(file);
    return undefined;
  }
}

function cacheAudio(key: string, file: string): void {
  const oldFile = audioCache.get(key);
  if (oldFile && oldFile !== file) {
    sessionFiles.delete(oldFile);
    unlink(oldFile).catch(() => {});
  }

  if (audioCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = audioCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestFile = audioCache.get(oldestKey);
      audioCache.delete(oldestKey);
      if (oldestFile) {
        sessionFiles.delete(oldestFile);
        unlink(oldestFile).catch(() => {});
      }
    }
  }

  audioCache.set(key, file);
  sessionFiles.add(file);
}

function cleanupFiles(): void {
  for (const file of sessionFiles) {
    try {
      unlinkSync(file);
    } catch {
      // Ignore
    }
  }
  sessionFiles.clear();
  audioCache.clear();
}

let alertSoundFile: string | undefined;

/** Generates a small pleasant 120ms rising chime (700Hz -> 1050Hz) in PCM WAV format. */
function generateAlertWav(): Buffer {
  const sampleRate = 44100;
  const duration = 0.12;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = Buffer.alloc(44 + numSamples * 2);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.sin((Math.PI * i) / numSamples);
    const freq = 700 + 350 * (i / numSamples);
    const sample = Math.sin(2 * Math.PI * freq * t) * env * 0.25 * 32767;
    buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
  }
  return buffer;
}

async function getAlertSoundFile(): Promise<string> {
  if (alertSoundFile) return alertSoundFile;
  const path = join(tmpdir(), "pi-tts-alert-" + process.pid + ".wav");
  await writeFile(path, generateAlertWav());
  sessionFiles.add(path);
  alertSoundFile = path;
  return path;
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
  try {
    const alertFile = await getAlertSoundFile();
    const alertController = new AbortController();
    await play(alertFile, alertController.signal);
  } catch {
    // Alert playback error should not block speaking
  }
  await startSpeaking(ctx);
}

async function startSpeaking(ctx: ExtensionContext): Promise<void> {
  const msg = lastAssistantMessage(ctx);
  if (!msg) {
    ctx.ui.notify("tts: no assistant message yet", "warning");
    return;
  }

  const cacheKey = `${msg.id}:${TTS_MODEL()}:${TTS_VOICE()}:${SUMMARY_MODEL()}`;
  const controller = new AbortController();

  const cachedFile = await getCachedAudio(cacheKey);
  if (cachedFile) {
    const run = { controller, file: cachedFile };
    current = run;
    try {
      ctx.ui.setStatus("tts", "▶ speaking");
      await play(cachedFile, controller.signal);
    } catch (err) {
      if (String(err) !== "aborted" && !controller.signal.aborted) {
        ctx.ui.notify("tts: " + String(err), "error");
      }
    } finally {
      if (current === run) {
        current = undefined;
        ctx.ui.setStatus("tts", undefined);
      }
    }
    return;
  }

  // Unique per run so a superseded run's cleanup can't delete the new file.
  const file = join(tmpdir(), "pi-tts-" + process.pid + "-" + ++runSeq + ".wav");
  const run = { controller, file };
  current = run;

  let cached = false;
  try {
    ctx.ui.setStatus("tts", "summarizing…");
    const summary = await summarize(msg.text, controller.signal);

    ctx.ui.setStatus("tts", "synthesizing…");
    const audio = await synthesize(summary, controller.signal);

    await writeFile(file, audio);
    cacheAudio(cacheKey, file);
    cached = true;

    ctx.ui.setStatus("tts", "▶ speaking");
    await play(file, controller.signal);
  } catch (err) {
    if (String(err) !== "aborted" && !controller.signal.aborted) {
      ctx.ui.notify("tts: " + String(err), "error");
    }
  } finally {
    if (!cached) {
      await unlink(file).catch(() => {});
    }
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

  pi.on("session_shutdown", () => {
    stopCurrent();
    cleanupFiles();
  });

  process.on("exit", () => cleanupFiles());
}
