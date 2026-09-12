import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_API_URL = "https://velox.josevictor.me";

const STT_MODEL = () => process.env.STT_MODEL || "scribe";
const STT_LANGUAGE = () => process.env.STT_LANGUAGE || "";
const STT_MAX_SECONDS = () => Number(process.env.STT_MAX_SECONDS) || 120;

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // s16 mono
const SILENCE_MS = 700; // pause that ends a phrase
const MAX_SEGMENT_MS = 20_000; // flush anyway if the speaker never pauses
const MIN_SEGMENT_BYTES = BYTES_PER_SECOND / 2; // 0.5 s
const SPEECH_RMS = 250; // ~0.8 % full scale
const METER_SLOTS = 28;
const METER_INTERVAL_MS = 100;
const BARS = "▁▂▃▄▅▆▇█";

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

/** Recorders must write raw s16le mono 16 kHz PCM to stdout. */
const RECORDER_ARGS: Record<string, string[]> = {
  "pw-record": ["--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "-"],
  ffmpeg: ["-loglevel", "quiet", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
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

/** Start recording to stdout; rejects early if the binary fails to spawn. */
function startRecording(cmd: string, args: string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
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

/** Peak (for the meter) and RMS (for speech detection) of one PCM chunk. */
function levels(chunk: Buffer): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = chunk.readInt16LE(i);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sum += sample * sample;
    count++;
  }
  return { peak, rms: count ? Math.sqrt(sum / count) : 0 };
}

/** Map a peak amplitude onto a block character, -60 dBFS upwards. */
function bar(peak: number): string {
  if (peak < 32) return BARS[0];
  const db = 20 * Math.log10(peak / 32768);
  const index = Math.round(((db + 60) / 60) * (BARS.length - 1));
  return BARS[Math.min(BARS.length - 1, Math.max(0, index))];
}

/** Wrap raw PCM in a 44-byte WAV header. */
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
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

interface Recording {
  proc: ChildProcess;
  ctx: ExtensionContext;
  timer: NodeJS.Timeout;
  /** PCM of the phrase currently being spoken. */
  segment: Buffer[];
  segmentBytes: number;
  /** Trailing silence inside the current segment. */
  silenceBytes: number;
  hadSpeech: boolean;
  totalBytes: number;
  meter: string[];
  lastPaint: number;
  pending: number;
  submitted: number;
  /** Serializes transcription so phrases land in the editor in order. */
  queue: Promise<void>;
}

let rec: Recording | undefined;
let stopping = false;

function ms(bytes: number): number {
  return (bytes / BYTES_PER_SECOND) * 1000;
}

function clock(totalBytes: number): string {
  const secs = Math.floor(totalBytes / BYTES_PER_SECOND);
  return Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
}

function paint(state: Recording): void {
  if (rec !== state) return; // recording already torn down
  state.lastPaint = Date.now();
  const wave = state.meter.join("").padStart(METER_SLOTS, BARS[0]);
  const tail = state.pending > 0 ? "  transcribing…" : "";
  state.ctx.ui.setWidget("stt", ["● " + wave + "  " + clock(state.totalBytes) + tail], {
    placement: "belowEditor",
  });
}

function appendToEditor(ctx: ExtensionContext, text: string): void {
  const cur = ctx.ui.getEditorText();
  ctx.ui.setEditorText(cur ? cur.replace(/\s+$/, "") + " " + text : text);
}

/** Ship the buffered phrase for transcription and start a fresh segment. */
function flushSegment(state: Recording): void {
  const pcm = Buffer.concat(state.segment);
  const speech = state.hadSpeech;
  state.segment = [];
  state.segmentBytes = 0;
  state.silenceBytes = 0;
  state.hadSpeech = false;
  if (!speech || pcm.length < MIN_SEGMENT_BYTES) return;

  state.pending++;
  state.submitted++;
  paint(state);
  state.queue = state.queue
    .then(() => transcribe(wav(pcm), AbortSignal.timeout(120_000)))
    .then((text) => {
      if (text) appendToEditor(state.ctx, text);
    })
    .catch((err) => {
      state.ctx.ui.notify("stt: " + String(err), "error");
    })
    .finally(() => {
      state.pending--;
      paint(state);
    });
}

function onChunk(state: Recording, chunk: Buffer): void {
  if (rec !== state) return;
  state.totalBytes += chunk.length;
  state.segment.push(chunk);
  state.segmentBytes += chunk.length;

  const { peak, rms } = levels(chunk);
  if (rms >= SPEECH_RMS) {
    state.hadSpeech = true;
    state.silenceBytes = 0;
  } else {
    state.silenceBytes += chunk.length;
  }

  state.meter.push(bar(peak));
  if (state.meter.length > METER_SLOTS) state.meter.shift();
  if (Date.now() - state.lastPaint >= METER_INTERVAL_MS) paint(state);

  const pause = state.hadSpeech && ms(state.silenceBytes) >= SILENCE_MS;
  if (pause || ms(state.segmentBytes) >= MAX_SEGMENT_MS) flushSegment(state);
}

async function toggleDictation(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return; // print/json modes: no-op

  if (stopping) {
    ctx.ui.notify("stt: still transcribing", "warning");
    return;
  }

  // Second press stops the recording and transcribes what is left.
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

  let proc: ChildProcess;
  try {
    proc = await startRecording(cmd, args);
  } catch (err) {
    ctx.ui.notify("stt: " + String(err), "error");
    return;
  }

  const state: Recording = {
    proc,
    ctx,
    timer: setTimeout(() => void finishRecording(), STT_MAX_SECONDS() * 1000),
    segment: [],
    segmentBytes: 0,
    silenceBytes: 0,
    hadSpeech: false,
    totalBytes: 0,
    meter: [],
    lastPaint: 0,
    pending: 0,
    submitted: 0,
    queue: Promise.resolve(),
  };
  rec = state;
  proc.stdout?.on("data", (chunk: Buffer) => onChunk(state, chunk));
  ctx.ui.setStatus("stt", "● recording — press again to stop");
  paint(state);
}

async function finishRecording(): Promise<void> {
  const state = rec;
  if (!state) return;
  stopping = true;
  clearTimeout(state.timer);

  try {
    await stopRecording(state.proc);
    flushSegment(state);
    await state.queue;
    if (state.submitted === 0) state.ctx.ui.notify("stt: nothing recorded", "warning");
  } finally {
    rec = undefined;
    state.ctx.ui.setStatus("stt", undefined);
    state.ctx.ui.setWidget("stt", undefined);
    stopping = false;
  }
}

/** Shutdown cleanup: kill the recorder and drop the UI. */
function cancel(): void {
  if (rec) {
    clearTimeout(rec.timer);
    rec.proc.kill("SIGKILL");
    rec.ctx.ui.setStatus("stt", undefined);
    rec.ctx.ui.setWidget("stt", undefined);
    rec = undefined;
  }
  stopping = false;
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
