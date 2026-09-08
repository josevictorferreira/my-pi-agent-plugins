import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { access, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_API_URL = "https://velox.josevictor.me";

const STT_MODEL = () => process.env.STT_MODEL || "scribe";
const STT_LANGUAGE = () => process.env.STT_LANGUAGE || "";
const STT_MAX_SECONDS = () => Number(process.env.STT_MAX_SECONDS) || 120;

function apiUrl(): string {
  return (process.env.VELOX_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
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

const RECORDER_ARGS: Record<string, string[]> = {
  "pw-record": ["--rate", "16000", "--channels", "1", "--format", "s16"],
  ffmpeg: ["-loglevel", "quiet", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-y"],
};

/** Resolve the recorder command: STT_RECORDER override, else first available. */
async function findRecorder(): Promise<{ cmd: string; args: string[] }> {
  const override = process.env.STT_RECORDER;
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw "STT_RECORDER is set but empty";
    return { cmd: parts[0], args: parts.slice(1) };
  }
  for (const bin of Object.keys(RECORDER_ARGS)) {
    if (await canExecute(bin)) return { cmd: bin, args: RECORDER_ARGS[bin] };
  }
  throw "no audio recorder found (tried pw-record, ffmpeg)";
}

/** Start recording into file; rejects early if the binary fails to spawn. */
function startRecording(cmd: string, args: string[], file: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args.concat(file), { stdio: "ignore" });
    child.on("error", (err) => reject("recorder " + cmd + " failed to start: " + String(err)));
    // Once spawned, the process keeps running until stopped.
    child.on("spawn", () => resolve(child));
  });
}

/** SIGINT the recorder; escalate to SIGKILL after 2 s. */
function stopRecording(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    proc.on("close", () => {
      done = true;
      resolve();
    });
    proc.kill("SIGINT");
    setTimeout(() => {
      if (!done) proc.kill("SIGKILL");
    }, 2000);
  });
}

/** Cheap silence guard: >= 0.5 s of audio and a peak above ~1 % full scale. */
function hasSpeech(buf: Buffer): boolean {
  if (buf.length <= 44 + 16000 * 2) return false; // shorter than 0.5 s of s16 mono
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 4 * 2) {
    const sample = Math.abs(buf.readInt16LE(i));
    if (sample > peak) peak = sample;
    if (peak > 328) return true;
  }
  return false;
}

/** Transcribe a wav clip through Velox. Returns trimmed text or throws a string. */
async function transcribe(buf: Buffer, signal: AbortSignal): Promise<string> {
  const key = process.env.VELOX_API_KEY;
  if (!key) throw "VELOX_API_KEY is not set";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "clip.wav");
  form.append("model", STT_MODEL());
  const language = STT_LANGUAGE();
  if (language) form.append("language", language);

  let response: Response;
  try {
    response = await fetch(apiUrl() + "/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
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

  const data: any = await response.json();
  return String(data?.text ?? "").trim();
}

// --- Session-scoped recording state -----------------------------------------

let rec: {
  proc: ChildProcess;
  file: string;
  timer: NodeJS.Timeout;
  ctx: ExtensionContext;
} | undefined;
let transcribing = false;

async function toggleDictation(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return; // print/json modes: no-op

  if (transcribing) {
    ctx.ui.notify("stt: still transcribing", "warning");
    return;
  }

  // Second press stops the recording and transcribes.
  if (rec) {
    await finishRecording();
    return;
  }

  if (!process.env.VELOX_API_KEY) {
    ctx.ui.notify("stt: VELOX_API_KEY is not set", "error");
    return;
  }

  let cmd: string;
  let args: string[];
  try {
    ({ cmd, args } = await findRecorder());
  } catch (err) {
    ctx.ui.notify("stt: " + String(err), "error");
    return;
  }

  const file = join(tmpdir(), "pi-stt-" + process.pid + ".wav");
  let proc: ChildProcess;
  try {
    proc = await startRecording(cmd, args, file);
  } catch (err) {
    ctx.ui.notify("stt: " + String(err), "error");
    return;
  }

  const timer = setTimeout(() => void finishRecording(), STT_MAX_SECONDS() * 1000);
  rec = { proc, file, timer, ctx };
  ctx.ui.setStatus("stt", "● recording — press again to stop");
}

async function finishRecording(): Promise<void> {
  const state = rec;
  if (!state) return;
  rec = undefined;
  clearTimeout(state.timer);

  const ctx = state.ctx;
  transcribing = true;
  ctx.ui.setStatus("stt", "transcribing…");

  try {
    await stopRecording(state.proc);
    const buf = await readFile(state.file);
    if (!hasSpeech(buf)) {
      ctx.ui.notify("stt: nothing recorded", "warning");
      return;
    }
    const text = await transcribe(buf, AbortSignal.timeout(120_000));
    if (!text) {
      ctx.ui.notify("stt: empty transcript", "warning");
      return;
    }
    const cur = ctx.ui.getEditorText();
    ctx.ui.setEditorText(cur ? cur.replace(/\s+$/, "") + " " + text : text);
  } catch (err) {
    ctx.ui.notify("stt: " + String(err), "error");
  } finally {
    await unlink(state.file).catch(() => {});
    ctx.ui.setStatus("stt", undefined);
    transcribing = false;
  }
}

/** Shutdown cleanup: kill the recorder, abort any in-flight fetch, drop files. */
function cancel(): void {
  if (rec) {
    clearTimeout(rec.timer);
    rec.proc.kill("SIGKILL");
    const file = rec.file;
    unlink(file).catch(() => {});
    rec.ctx.ui.setStatus("stt", undefined);
    rec = undefined;
  }
  transcribing = false;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("dictate", {
    description: "Record from the microphone and insert the transcript into the prompt (again: stop)",
    handler: async (_args, ctx) => toggleDictation(ctx),
  });

  pi.registerShortcut("ctrl+alt+d", {
    description: "Toggle voice dictation into the prompt",
    handler: (ctx) => toggleDictation(ctx),
  });

  pi.on("session_shutdown", () => cancel());
}
