# stt

Dictate into the pi prompt: record from the microphone, transcribe through
Velox, and insert the text into the input editor. The transcript never enters
the LLM conversation and nothing is auto-submitted — you review, edit, and
press Enter yourself.

## Usage

- `/dictate` or `ctrl+alt+d` — toggle. First press starts recording, second
  press stops it and sends the clip for transcription.
- The transcript is appended to the end of the current editor contents
  (with a single space separator if the editor is non-empty).
- Recording auto-stops after `STT_MAX_SECONDS` and transcribes normally.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `VELOX_API_URL` | `https://velox.josevictor.me` | shared with tts/web-tools |
| `VELOX_API_KEY` | — | required; checked before recording starts |
| `STT_MODEL` | `scribe` | transcription combo/model alias (velox `[combos.scribe]`: elevenlabs-stt) |
| `STT_LANGUAGE` | unset (auto-detect) | ISO-639-1 code sent as `language` |
| `STT_RECORDER` | auto-detect | recorder command; output path appended as last arg |
| `STT_MAX_SECONDS` | `120` | auto-stop cap |

## Recorder detection

`STT_RECORDER` if set (whitespace-split), else the first available of:

1. `pw-record --rate 16000 --channels 1 --format s16`
2. `ffmpeg -loglevel quiet -f pulse -i default -ac 1 -ar 16000 -y`

Audio is captured as 16 kHz mono s16 WAV into a temp file. The recorder is
stopped with `SIGINT` (escalating to `SIGKILL` after 2 s).

## Behavior details

- **Silence guard:** clips shorter than 0.5 s or with a peak amplitude below
  ~1 % of full scale are skipped ("nothing recorded") — Whisper-class models
  hallucinate on silence, and there is no point paying for it.
- **Errors** (`VELOX_API_KEY` missing, no recorder, HTTP errors) are surfaced
  as notifications; the endpoint's `{ error: { message } }` envelope is relayed
  verbatim.
- **Print/JSON modes:** `/dictate` is a no-op.
- On `session_shutdown` any in-flight recording is killed and its temp file
  removed.
