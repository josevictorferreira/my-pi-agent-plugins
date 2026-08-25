# Implementation Plan: `stt` extension (dictate into the pi prompt via Velox)

## Goal

Add a pi extension at `extensions/stt/index.ts` that records from the microphone
on demand, transcribes the clip through Velox `POST /v1/audio/transcriptions`,
and inserts the text into pi's input editor for the user to review and submit.
Nothing enters the LLM conversation and nothing is auto-submitted; this is a
pure input convenience, the mirror image of `extensions/tts`.

**Style anchor:** `extensions/tts/index.ts` — same `apiUrl()`, `veloxFetch`-style
helper with the `{error:{message}}` envelope parser, module-scope
`AbortController` for the in-flight run, `ctx.ui.setStatus` progress, spawn
helper with `stdio: "ignore"`, string concatenation, default-export factory.

## Research findings (what makes this possible without tmux)

- **pi can write the prompt directly.** `ExtensionContext.ui` exposes
  `getEditorText(): string`, `setEditorText(text): void` and
  `pasteToEditor(text)` (`pi-coding-agent/dist/core/extensions/types.d.ts:129-133`).
  So the tmux `send-keys` route is unnecessary; it is listed below only as the
  rejected alternative.
- **Velox has STT.** `POST /v1/audio/transcriptions` — multipart form, required
  `file` (extension must be one of wav/mp3/flac/m4a/ogg/webm/aac) and `model`;
  optional `language`, `prompt`, `response_format`. Returns the upstream JSON
  verbatim. Configured alias: **`stt-1`** (listed by `/v1/models`; `whisper-1`
  and `stt-primary` are 404). Live probe of a 4 s 16 kHz mono wav returned
  `{"text":"…","usage":{"cost":0.0004,"seconds":4}}`.
  Errors: OpenAI-shaped envelope; 404 unknown alias, 413 over
  `audio_body_limit_bytes`, 502 upstream exhausted — same as `/speech`.
- **Whisper hallucinates on silence.** The probe (room noise only) came back as
  a Russian "subtitles by …" credit line. Plan a silence guard (below).
- **Recorders on this machine:** `pw-record` (PipeWire) and `ffmpeg` exist;
  `arecord`, `parecord`, `sox` do not. `pw-record --rate 16000 --channels 1 --format s16 file.wav`
  writes a valid RIFF header even when killed with SIGTERM (verified with `timeout`).

## Decisions (made, with the alternative noted)

| Decision | Choice | Alternative |
| --- | --- | --- |
| Trigger | `/dictate` command **and** `ctrl+alt+d` shortcut, both calling the same toggle: first press starts recording, second press stops and transcribes. Push-to-talk is impossible (the TUI gets no key-up events), so toggle is the only keyboard model that works. | Fixed-length recording (e.g. 10 s). Rejected: forces the user to race a timer. |
| Where the text goes | Editor only: `setEditorText(existing + sep + transcript)` where `sep` is `""` if editor empty, else `" "`. User reads, edits, presses Enter. | `pi.sendUserMessage(text)` to auto-submit. Rejected by default — STT errors would fire off wrong prompts. Offer as `/dictate send` later if wanted. |
| Recorder | Spawn first available of `pw-record --rate 16000 --channels 1 --format s16 <file>`, `ffmpeg -loglevel quiet -f pulse -i default -ac 1 -ar 16000 -y <file>`; env override `STT_RECORDER` (whitespace-split, `<file>` appended). Stop with `SIGINT`, wait for `close`. | `arecord`/`sox` — not installed. Piping stdout — pw-record writes WAV headers only to a seekable file, so a temp file is required anyway. |
| Format | 16 kHz mono s16 wav. Whisper-class models resample to 16 kHz internally; ~32 KB/s keeps a 60 s clip under 2 MB, well below any plausible `audio_body_limit_bytes`. | mp3/ogg via ffmpeg — smaller but needs an encoder step; not worth it. |
| Max length | Hard cap of `STT_MAX_SECONDS` (default 120) via a timer that auto-stops and transcribes, so a forgotten recording cannot grow unbounded or hit 413. | None. |
| Silence guard | Skip the upload when the wav is < 0.5 s or its peak amplitude < ~1 % full scale (scan the s16 samples after the 44-byte header); notify "nothing recorded". Cheap, avoids paying for hallucinated text. | Trust the API. Rejected after the probe. |
| Language | Send `language` only when `STT_LANGUAGE` is set (e.g. `pt`, `en`). Letting Whisper auto-detect is fine for one user but pinning it also kills the hallucination class seen above. | — |
| Not a tool | No `registerTool`. The model has no reason to call this. | — |
| Multipart | Native `fetch` + `FormData` + `Blob` (Node ≥ 18 / Bun). No dependency. | `form-data` package — violates the "no per-plugin deps" convention. |
| tmux fallback | **Not needed.** Kept in "Out of scope" for the record. | — |

## Velox API contract (verified against `/docs/openapi.json` and a live call)

- `POST /v1/audio/transcriptions` — `multipart/form-data`, fields `file` (binary,
  filename ending in `.wav`), `model` (`stt-1`), optional `language`, `prompt`,
  `response_format`. Response `{ text: string, usage?: { cost, seconds } }`.
- Auth: `Authorization: Bearer $VELOX_API_KEY`. Base `https://velox.josevictor.me`.
  Do **not** set `Content-Type` manually — let `fetch` add the multipart boundary.

## Configuration (env vars, hardcoded defaults)

| Var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | shared with web-tools/tts |
| `VELOX_API_KEY` | — | required; error notification if unset |
| `STT_MODEL` | `stt-1` | transcription alias |
| `STT_LANGUAGE` | unset (auto-detect) | ISO-639-1 code passed as `language` |
| `STT_RECORDER` | auto-detect | explicit recorder command; output path is appended as last arg |
| `STT_MAX_SECONDS` | `120` | auto-stop cap |

## File layout

```
extensions/stt/
├── index.ts     # everything (~170 lines)
└── README.md    # contract: command, shortcut, env vars, recorder detection, editor behavior
```

## Implementation steps

### 1. Helpers (top of `index.ts`)

- `apiUrl()` — copy from tts.
- `veloxError(res)` — parse `{error:{message}}`; copy the block from tts `veloxFetch`.
- `findRecorder()` — `STT_RECORDER` split on whitespace, else probe `pw-record`,
  `ffmpeg` over `PATH` with `access()` (same loop as tts `findPlayer`). Return
  `{ cmd, args }` with the `<file>` slot filled; throw a string naming what was tried.
- `startRecording(file)` — `spawn(cmd, args, { stdio: "ignore" })`; return the
  `ChildProcess`. Reject early on `error` event (ENOENT).
- `stopRecording(proc)` — `proc.kill("SIGINT")`, await `close`; if it has not
  exited after 2 s, `SIGKILL`.
- `hasSpeech(buf)` — `buf.length > 44 + 16000` (≥ 0.5 s) and
  `max(|readInt16LE|)` over the samples `> 328` (~1 % of 32767). Stride by 4
  samples to keep it O(n/4) with no perceptible cost.
- `transcribe(buf, signal)` — build `FormData`: `file` = `new Blob([buf], {type:"audio/wav"})`
  as `"clip.wav"`, `model`, optional `language`. `fetch(apiUrl()+"/v1/audio/transcriptions", { method:"POST", headers:{Authorization}, body, signal })`.
  Parse JSON, return `String(json.text ?? "").trim()`.

### 2. State and orchestration

Module scope: `let rec: { proc, file, timer, ctx } | undefined; let transcribing = false;`

```
toggleDictation(ctx):
  if (!ctx.hasUI) return                                   // print/json: no-op
  if (transcribing) { notify("still transcribing", "warning"); return }
  if (rec) return await finishRecording()                  // second press → stop
  if (!process.env.VELOX_API_KEY) { notify error; return } // fail before recording
  file = join(tmpdir(), "pi-stt-" + process.pid + ".wav")
  proc = await startRecording(file)
  timer = setTimeout(finishRecording, STT_MAX_SECONDS * 1000)
  rec = { proc, file, timer, ctx }
  ctx.ui.setStatus("stt", "● recording — press again to stop")

finishRecording():
  { proc, file, timer, ctx } = rec; rec = undefined; clearTimeout(timer)
  transcribing = true; ctx.ui.setStatus("stt", "transcribing…")
  try
    await stopRecording(proc)
    buf = await readFile(file)
    if (!hasSpeech(buf)) { notify("stt: nothing recorded", "warning"); return }
    text = await transcribe(buf, controller.signal)
    if (!text) { notify("stt: empty transcript", "warning"); return }
    cur = ctx.ui.getEditorText()
    ctx.ui.setEditorText(cur ? cur.replace(/\s+$/, "") + " " + text : text)
  catch (e) notify("stt: " + String(e), "error")
  finally unlink(file).catch(()=>{}); ctx.ui.setStatus("stt", undefined); transcribing = false
```

- `session_shutdown` → `cancel()`: kill the recorder with `SIGKILL`, abort any
  in-flight fetch, unlink the temp file, clear status. Idempotent.
- Use the `ctx` captured at start for `finishRecording` — the shortcut/command
  ctx passed on the second press is equivalent, but the timer path has none.
- `setEditorText` on a full replace resets the cursor; that is acceptable —
  the transcript is appended at the end where the cursor lands anyway.

### 3. Registration

```ts
pi.registerCommand("dictate", {
  description: "Record from the microphone and insert the transcript into the prompt (again: stop)",
  handler: async (_args, ctx) => toggleDictation(ctx),
});
pi.registerShortcut("ctrl+alt+d", {
  description: "Toggle voice dictation into the prompt",
  handler: (ctx) => toggleDictation(ctx),
});
pi.on("session_shutdown", () => cancel());
```

`ctrl+alt+d` is not in the built-in table (`keybindings.md`; `ctrl+d` alone is
delete-forward, the alt variant is free). Rebind via `~/.pi/agent/keybindings.json`
if the terminal eats it.

### 4. README + AGENTS.md

- `extensions/stt/README.md`: command, shortcut, toggle semantics, env vars,
  recorder order, silence guard, "never auto-submits, never enters LLM context".
- Add an `stt/` row to the STRUCTURE tree and WHERE TO LOOK table in `AGENTS.md`.

## Verification

1. `bun run check` passes.
2. `pi -e ./extensions/stt/index.ts` in a scratch dir:
   - `/dictate` → status shows "● recording"; speak a sentence; `/dictate` again →
     status "transcribing…" → text appears in the editor, status clears, no
     `pi-stt-*.wav` left in `$TMPDIR`.
   - `ctrl+alt+d` twice does the same.
   - Type "please " first, then dictate → editor reads `please <transcript>`.
   - Start, stay silent, stop → "nothing recorded" warning, no network call
     (check with `VELOX_API_URL=http://127.0.0.1:1` — must still show the
     silence warning, not a connection error).
   - Start and wait `STT_MAX_SECONDS=5` → auto-stops and transcribes.
   - `unset VELOX_API_KEY` → error notification **before** the recorder starts.
   - `STT_RECORDER=nonexistent-bin` → error naming the recorder; no stuck status.
   - `STT_MODEL=whisper-1` → 404 message surfaced verbatim.
   - Quit while recording → `pgrep pw-record` empty, temp file gone.
   - `STT_LANGUAGE=pt` with a Portuguese sentence → correct transcript, no
     translation.
3. `pi --mode print -e … ` with `/dictate` in input → no-op, no error.
4. `git diff` shows only `extensions/stt/*`, `AGENTS.md`, this plan; no secrets.

## Out of scope (say so if wanted later)

- Auto-submit (`/dictate send` or a `STT_AUTO_SEND` flag) using `pi.sendUserMessage`.
- Streaming/partial transcripts while still recording.
- tmux fallback (`tmux send-keys -l "<text>"` into the pi pane). Only relevant
  if pi ever loses `setEditorText`; today it exists and is the right API.
- Local/offline STT (`whisper.cpp`) — Velox `stt-1` is already wired and costs
  ~$0.0001/s.
- Sharing the `veloxFetch`/`apiUrl` helpers with tts in a common module. Each
  extension is meant to load standalone; copying ~20 lines matches the repo's
  existing web-tools/tts duplication.
