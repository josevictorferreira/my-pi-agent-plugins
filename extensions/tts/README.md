# tts

Summarizes the last agent reply and plays it as speech. Pure user-facing
convenience: no tools, nothing enters the LLM conversation.

## Usage

- `/speak` — summarize the last assistant message and speak it. Invoking it
  again while busy stops the current playback.
- `ctrl+alt+s` — same action.
- Auto mode: set `TTS_AUTO_SPEAK=1` to speak automatically every time the agent
  stops (reply finished, question asked, or run aborted). A new reply cuts off
  any playback still in progress. `/speak` still works as a manual stop.

## Behavior

1. Reads the latest assistant text from the current session branch.
2. Short, code-free replies (≤300 chars) are spoken directly after stripping
   markdown; longer ones are summarized in 2–3 spoken sentences via Velox
   `POST /v1/chat/completions`.
3. Speech is synthesized with Velox `POST /v1/audio/speech` (mp3), written to a
   temp file, and played locally. The temp file is removed after playback.
4. No-op without a UI (print/json modes). Playback is aborted on
   `session_shutdown`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | Velox base URL (shared with web-tools) |
| `VELOX_API_KEY` | — | required bearer token |
| `TTS_MODEL` | `tts-1` | speech model alias |
| `TTS_VOICE` | `geffen_32` | voice |
| `TTS_SUMMARY_MODEL` | `deepseek-v4-flash` | chat model alias for the summary |
| `TTS_AUTO_SPEAK` | off | `1`/`true` speaks every reply automatically when the agent stops |
| `TTS_PLAYER` | auto-detect | explicit player command, e.g. `mpv --no-video --really-quiet` |

## Player detection

`TTS_PLAYER` (split on whitespace) if set; otherwise the first available of
`mpv --no-video --really-quiet`, `ffplay -nodisp -autoexit -loglevel quiet`,
`pw-play`.
