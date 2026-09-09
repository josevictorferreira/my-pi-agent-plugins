# notify

Desktop notifications for pi: when a run settles (`agent_settled`), the last
assistant message is inspected once and a single popup says what happened —
done, a question aimed at you, or an error. Aborted runs stay silent, because
the user is, by definition, still there. Works the same in `-p` print mode
and the TUI.

## What fires

| last assistant message | kind | urgency | expire | icon |
| --- | --- | --- | --- | --- |
| `stopReason: error` | error | critical | persistent | `dialog-error` |
| `stopReason: aborted` | nothing | — | — | — |
| last non-empty line ends with `?` | question | normal | persistent | `dialog-question` |
| anything else | success | low | 5000 ms | `dialog-information` |

Titles look like `pi (my-project): done`: the prefix comes from `NOTIFY_TITLE`,
the project directory name is appended when it has one, then the kind
(`done`, `question`, `error`).

Bodies are one-line teasers — for a question the last line of the reply, for
an error `errorMessage` (falling back to `stopReason`), for success the whole
reply — with newlines collapsed to spaces and capped at 200 characters.

## Command

The popup is sent by running `NOTIFY_COMMAND` (default `notify-send`) with a
notify-send-style argv:

    <command> --app-name pi --icon <icon> --urgency <urgency> --expire-time <ms> --category <category> <title> <body>

Errors use `--urgency critical --category im.error --expire-time 0`
(persistent), questions `--urgency normal --expire-time 0`, success
`--urgency low --expire-time 5000 --category im`. Any binary or wrapper
script that accepts this argv works.

It is spawned directly through `pi.exec` — no shell, 5 s timeout. If it exits
non-zero or cannot be spawned (say `notify-send` is not on PATH), you get
**one** `warning` toast per session and then silence; nothing throws and the
session is never disturbed.

Duplicate `agent_settled` firings for the same assistant message are deduped
by message id; dedupe and warning state reset on `session_start`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTIFY_ENABLED` | `1` | `0`, `false` or `off` disables the extension entirely |
| `NOTIFY_COMMAND` | `notify-send` | binary to run; must speak the notify-send argv above |
| `NOTIFY_TITLE` | `pi` | title prefix, before ` (project-dir): kind` |

## macOS

`notify-send` is a freedesktop/Linux tool. On macOS, point `NOTIFY_COMMAND`
at a wrapper script that accepts the same argv and calls `osascript`; see
`../../.agents/specs/0002-notify/plan.md` §7 for the sketch. A native
`osascript` path is deliberately not implemented.

## What it does not do

No model-facing tool, no `/notify` command, no shortcut — it only listens for
`agent_settled` and `session_start`.
