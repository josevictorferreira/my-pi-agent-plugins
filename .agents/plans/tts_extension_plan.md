# Implementation Plan: `tts` extension (spoken summary of the last agent reply via Velox)

## Goal

Add a pi extension at `extensions/tts/index.ts` that, on demand, takes the last
assistant message in the current session, asks an LLM for a short spoken-style
summary, converts it to speech through Velox `POST /v1/audio/speech`, and plays
the audio locally. Nothing enters the LLM conversation; this is a pure
user-facing convenience.

**Style anchor:** `extensions/web-tools/index.ts` — `callVelox`-style fetch
helper, `apiUrl()` reading `VELOX_API_URL`/`VELOX_API_KEY`, string
concatenation, default-export factory. Reuse the last-assistant-text logic
shape from `extensions/hindsight/index.ts` (`messageText`).

## Decisions (made, with the alternative noted)

| Decision | Choice | Alternative |
| --- | --- | --- |
| Trigger | `/speak` command **and** a `ctrl+alt+s` shortcut that calls the same function. Command is discoverable; shortcut is the fast path. | Command only. Shortcut is ~4 lines; keep both. |
| Summarizer | Velox `POST /v1/chat/completions` with a cheap alias (`TTS_SUMMARY_MODEL`, default `deepseek-v4-flash`). Same base URL, same key, one HTTP helper, zero coupling to pi's model/auth internals. | `ctx.modelRegistry.complete(ctx.model, …)` uses the session model — but it charges the session provider, is slower on big models, and needs pi-ai `Context` types. Not worth it here. |
| Player | Spawn the first available of `mpv --no-video --really-quiet`, `ffplay -nodisp -autoexit -loglevel quiet`, `pw-play` (env override `TTS_PLAYER`). All three exist on this machine. | Pipe to stdin. mpv/ffplay read `-`; pw-play does not play mp3 from stdin reliably → write a temp file, simplest and uniform. |
| Not a tool | No `registerTool`. The model has no reason to call this. | — |
| No session state | Nothing persisted; the "last message" is re-read from `ctx.sessionManager.getBranch()` each time. | — |

## Velox API contract (verified against `/docs/openapi.json` and a live `/v1/models` call)

- `POST /v1/audio/speech` — body `{ model, input (1–4096 chars), voice?, response_format?, speed? }`.
  Returns raw audio bytes with upstream content type (`audio/mpeg` for mp3).
  Configured TTS alias: `tts-1`. Voice used today: `geffen_32`.
  Errors: OpenAI-shaped `{ error: { message } }`; 404 unknown alias, 413 body too large, 502 upstream exhausted.
- `POST /v1/chat/completions` — standard OpenAI shape; `model` must be a configured alias. `deepseek-v4-flash`, `gemini-3-7-flash`, `gemini-flash-lite-puter` are available cheap options.
- Auth: `Authorization: Bearer $VELOX_API_KEY`. Base `https://velox.josevictor.me`.

## Configuration (env vars, hardcoded defaults)

| Var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | shared with web-tools |
| `VELOX_API_KEY` | — | required; `/speak` notifies an error if unset |
| `TTS_MODEL` | `tts-1` | speech alias |
| `TTS_VOICE` | `geffen_32` | voice |
| `TTS_SUMMARY_MODEL` | `deepseek-v4-flash` | chat alias for the summary |
| `TTS_PLAYER` | auto-detect | explicit player command, e.g. `mpv --no-video --really-quiet` |

## File layout

```
extensions/tts/
├── index.ts     # everything (~150 lines)
└── README.md    # contract: command, shortcut, env vars, player detection
```

## Implementation steps

### 1. Helpers (top of `index.ts`)

- `apiUrl()` — copy from web-tools.
- `veloxHeaders()` — `Content-Type` + bearer.
- `lastAssistantText(ctx)` — walk `ctx.sessionManager.getBranch()` backwards;
  first entry with `entry.type === "message" && entry.message.role === "assistant"`;
  join `content` blocks of `type === "text"`, trim. Return `undefined` if none.
- `summarize(text, signal)` — POST `/v1/chat/completions` with
  `{ model, messages: [{role:"system", content: PROMPT}, {role:"user", content: text.slice(0, 20000)}], max_tokens: 200 }`.
  Prompt: "Summarize the assistant message below for text-to-speech in 2–3 plain
  spoken sentences. No markdown, no code, no lists, no file paths." Return
  `choices[0].message.content.trim()`, clipped to 4000 chars (API max 4096).
  - Skip the LLM when `text.length <= 300` and it contains no code fence — just
    strip markdown and speak it directly. Saves a round-trip for short replies.
- `synthesize(summary, signal)` — POST `/v1/audio/speech`, body
  `{ model, input, voice, response_format: "mp3" }`; return `Buffer.from(await res.arrayBuffer())`.
- `play(file, signal)` — pick player (`TTS_PLAYER` split on whitespace, else
  probe `mpv`, `ffplay`, `pw-play` via `which`-style lookup over `PATH`), `spawn`
  with `stdio: "ignore"`, resolve on `close`, kill on `signal.abort`.
- Error handling: one shared `veloxError(res)` that parses the `{error:{message}}`
  envelope, mirrors `callVelox` in web-tools.

### 2. `speakLastMessage(ctx)` orchestration

```
if (!ctx.hasUI) return                         // print/json modes: no-op
if (busy) { notify("Already speaking", "warning"); return }
text = lastAssistantText(ctx); if none → notify("No assistant message yet")
busy = true; ctx.ui.setStatus("tts", "summarizing…")
  summary = await summarize(text)
  ctx.ui.setStatus("tts", "synthesizing…")
  audio = await synthesize(summary)
  write to os.tmpdir()/pi-tts-<pid>.mp3
  ctx.ui.setStatus("tts", "▶ speaking")
  await play(file)
finally: unlink temp file, ctx.ui.setStatus("tts", undefined), busy = false
catch: ctx.ui.notify("tts: " + message, "error")
```

- Use one `AbortController` per run stored in module scope; a second
  `/speak` (or `/speak stop`) while busy aborts the current one instead of
  queuing — better UX than "already speaking".
- Abort must also fire from `session_shutdown` (kill player, clean temp file).

### 3. Registration

```ts
pi.registerCommand("speak", {
  description: "Summarize the last agent reply and play it as speech (again: stop)",
  handler: async (_args, ctx) => speakLastMessage(ctx),
});
pi.registerShortcut("ctrl+alt+s", {
  description: "Speak summary of last agent reply",
  handler: (ctx) => speakLastMessage(ctx),
});
pi.on("session_shutdown", () => stopCurrent());
```

`ctrl+alt+s` is not in the built-in keybinding table (`keybindings.md`); user
can rebind via `~/.pi/agent/keybindings.json` if it conflicts with their terminal.

### 4. README + AGENTS.md

- `extensions/tts/README.md`: command, shortcut, env vars, player order, "not a
  tool, never enters LLM context".
- Add a `tts/` row to the STRUCTURE tree and WHERE TO LOOK table in `AGENTS.md`
  (the file lists every extension). One-line entry each.

## Verification

1. `bun run check` passes.
2. `pi -e ./extensions/tts/index.ts` in a scratch dir:
   - `/speak` before any reply → "No assistant message yet" notification.
   - Ask something, `/speak` → status cycles summarizing → synthesizing → speaking; audio plays; status clears; temp file gone.
   - `ctrl+alt+s` does the same.
   - `/speak` while speaking → playback stops immediately.
   - Unset `VELOX_API_KEY` → clear error notification, no crash.
   - `TTS_PLAYER=nonexistent-bin` → error notification naming the player.
   - Long reply with code blocks → summary is prose, no code read aloud.
   - Quit mid-playback → player process is killed (check `pgrep mpv`).
3. `pi --mode print -e …` with `/speak` in input → no-op, no error.
4. `git diff` shows no secrets; only `extensions/tts/*` and `AGENTS.md` changed.

## Out of scope (say so if wanted later)

- Auto-speak every reply on `agent_end` (easy follow-up: same function behind a `/speak auto` toggle).
- Streaming audio / speaking the full message instead of a summary.
- Voice/model picker UI (`ctx.ui.select`) — env vars suffice for one user.
