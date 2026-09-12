# stt

Dictate into the pi prompt: record from the microphone, transcribe through
Velox, and insert the text into the input editor. The transcript never enters
the LLM conversation and nothing is auto-submitted — you review, edit, and
press Enter yourself.

## Usage

- `/dictate` or `ctrl+alt+d` — toggle. First press starts recording, second
  press stops it and transcribes whatever is left in the buffer.
- While recording, a live meter sits below the editor:
  `● ▁▂▄▇█▇▅▃▂▁▁▂▅█▆▃▁  0:07  transcribing…`
- Text arrives **while you talk**: each time you pause for ~0.7 s the phrase is
  sent off and appended to the editor. Phrases are transcribed one at a time so
  they land in the order you spoke them.
- Recording auto-stops after `STT_MAX_SECONDS`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | shared with tts/web-tools |
| `VELOX_API_KEY` | — | required; checked before recording starts |
| `STT_MODEL` | `scribe` | transcription combo/model alias (velox `[combos.scribe]`: elevenlabs-stt) |
| `STT_LANGUAGE` | unset (auto-detect) | ISO-639-1 code sent as `language` |
| `STT_RECORDER` | auto-detect | recorder command; must write raw PCM to stdout |
| `STT_MAX_SECONDS` | `120` | auto-stop cap |

## Recorder detection

`STT_RECORDER` if set (whitespace-split), else the first available of:

1. `pw-record --raw --rate 16000 --channels 1 --format s16 -`
2. `ffmpeg -loglevel quiet -f pulse -i default -ac 1 -ar 16000 -f s16le -`

The recorder must emit **raw s16le mono 16 kHz PCM on stdout** — no container,
no output file. The extension reads that stream to drive the meter and the
pause detector, and wraps each phrase in a WAV header before uploading. The
recorder is stopped with `SIGINT` (escalating to `SIGKILL` after 2 s).

## Segmentation

Chunks are metered as they arrive (~10 per second). RMS at or above ~0.8 % full
scale counts as speech; a phrase is flushed when it has speech followed by
700 ms of silence, or when it reaches 20 s without a pause. Segments shorter
than 0.5 s, or with no speech at all, are dropped — Whisper-class models
hallucinate on silence, and there is no point paying for it.

## Behavior details

- **Errors** (`VELOX_API_KEY` missing, no recorder, HTTP errors) are surfaced
  as notifications; the endpoint's `{ error: { message } }` envelope is relayed
  verbatim. A failed phrase does not stop the recording.
- If a whole session produced no speech, you get "nothing recorded".
- **Print/JSON modes:** `/dictate` is a no-op.
- On `session_shutdown` any in-flight recording is killed and the UI cleared.
