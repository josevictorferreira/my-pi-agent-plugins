# Implementation Plan: `notify` Extension (desktop notification when a session stops)

Written against the installed Pi API (`@earendil-works/pi-coding-agent` 0.84.2, `@earendil-works/pi-ai` `StopReason`) and the conventions in `AGENTS.md`. Scope for this iteration: **Linux `notify-send` only**. macOS was researched (§7) and is left as a documented follow-up.

---

## 1. Goal

Push a desktop notification every time the agent stops, so the user can leave the terminal and come back when needed. The notification must look different for three outcomes:

| Outcome | Meaning | Notification |
| --- | --- | --- |
| `success` | run finished normally with a final reply | low-key, informational |
| `error` | run ended because the provider/agent failed | prominent, persistent |
| `question` | run finished and the reply is asking the user something | normal, distinct icon, says a question is waiting |

### Non-goals
- No model-facing tool, nothing enters the LLM conversation (same stance as `tts`/`stt`).
- No sounds (the `tts` chime already covers audio; a notification server can play its own).
- No "only notify if the terminal is unfocused" logic. Not portable; the notification server handles do-not-disturb.
- No minimum-duration filter, no per-project configuration, no notification history.
- macOS/Windows backends: researched, not implemented (§7).

---

## 2. Findings that shape the design

1. **Event choice.** `agent_end` fires per low-level run and may be followed by an auto-retry, auto-compaction or a queued follow-up. `agent_settled` fires once Pi will not continue on its own. That is the moment "the session stopped", so the extension hooks `agent_settled` (same event `tts` uses for auto-speak). `agent_settled` carries no payload, so the outcome is read from the session branch.
2. **Outcome source.** The last assistant message on `ctx.sessionManager.getBranch()` carries `stopReason` (`"stop" | "length" | "toolUse" | "error" | "aborted" | "pending" | "deferred"`) and `errorMessage`. That is enough to distinguish error from success without any extra bookkeeping.
3. **Aborted runs are skipped.** `stopReason === "aborted"` means the user pressed Escape or `/state-cancel`-style code aborted. The user is present; a notification would be noise. Stated assumption, easy to flip.
4. **Question detection is a heuristic.** Pi has no built-in "ask the user" tool (the `question.ts` example is opt-in). The reply text is the only signal. Rule: the last non-empty line of the final assistant text ends with `?`. False negatives (a question buried mid-reply) degrade to a `success` notification, which is acceptable.
5. **`notify-send` is available and works here.** Version 0.8.8 (libnotify) at `/etc/profiles/per-user/josevictor/bin/notify-send`; a smoke test from a Pi-like environment (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-1`, session D-Bus set) returned exit 0 and showed the popup. Relevant flags: `--app-name`, `--urgency low|normal|critical`, `--icon`, `--expire-time ms`, `--category`, `--transient`.
6. **Process launch.** Use `pi.exec(cmd, args, { timeout })` from `ExtensionAPI`. It spawns without a shell (no quoting issues with reply text), captures exit code and stderr, and exists in both 0.83 and 0.84. No need for `node:child_process`.
7. **Do not gate on `ctx.hasUI`.** Unlike `tts`, a desktop notification is exactly as useful for a headless `pi -p` run as for the TUI, and the print-mode command in `AGENTS.md` is the easiest way to test. `ctx.hasUI` is only consulted for the one-time "notify-send not found" warning.

---

## 3. Design

### 3.1 Layout

```
extensions/notify/
├── index.ts     # factory, agent_settled hook, exec of notify-send
└── README.md    # user contract: behaviour, env vars, classification rules
```

One file. Pure helpers are exported so they can be exercised from a scratch `bun` script (§5).

### 3.2 Data flow

```
agent_settled
  → lastAssistantMessage(ctx)          # branch walk, same as tts
  → skip if none, or if id === lastNotifiedId
  → outcome = classify(message)        # "success" | "error" | "question" | "skip"
  → skip if "skip"
  → { title, body, args } = buildNotification(outcome, message)
  → pi.exec("notify-send", args, { timeout: 5000 })
  → on non-zero exit / spawn failure: warn once via ctx.ui.notify (if hasUI), then stay quiet
```

### 3.3 Classification (`classify`)

```ts
export type Outcome = "success" | "error" | "question" | "skip";

export function classify(msg: { stopReason: string; text: string }): Outcome {
  if (msg.stopReason === "error") return "error";
  if (msg.stopReason === "aborted") return "skip";
  const lastLine = msg.text.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (lastLine.trimEnd().endsWith("?")) return "question";
  return "success";
}
```

`stopReason` is checked before text so an error whose `errorMessage` ends with `?` is still an error. `toolUse`/`pending`/`deferred` cannot be the final message of a settled run; they fall through to `success` rather than adding branches for impossible states.

### 3.4 Notification content (`buildNotification`)

| Outcome | urgency | icon | expire | title | body |
| --- | --- | --- | --- | --- | --- |
| success | `low` | `dialog-information` | 5000 ms | `pi: done` | first 200 chars of reply text |
| question | `normal` | `dialog-question` | 0 (persistent) | `pi: question` | the last line (the question itself), capped at 200 chars |
| error | `critical` | `dialog-error` | 0 (persistent) | `pi: error` | `errorMessage` if present, else `stopReason`, capped at 200 chars |

Common flags: `--app-name pi`, `--category im` (success/question) or `im.error` (error). Body text is passed as a plain argument via `pi.exec`, so no shell escaping. Newlines are collapsed to spaces; markdown is not stripped (keeps the code small; the body is a teaser, not a rendering).

Title prefix is configurable so several concurrent Pi sessions can be told apart (`NOTIFY_TITLE`, default `pi`). The project directory basename is appended when available: `pi (my-pi-agent-plugins): done`.

### 3.5 Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `NOTIFY_ENABLED` | `1` | `0`/`false`/`off` disables the extension without unloading it |
| `NOTIFY_COMMAND` | `notify-send` | override the binary (e.g. a wrapper script); receives the same argv |
| `NOTIFY_TITLE` | `pi` | title prefix |

Nothing else. Urgency/icon per outcome are fixed; if that ever needs tuning it is a one-line table edit.

### 3.6 Failure policy

- `notify-send` missing or exits non-zero: warn once per session through `ctx.ui.notify("notify: …", "warning")` when `ctx.hasUI`, remember `warned = true`, never throw. A notification failure must never surface as a session error (mirrors the Hindsight fire-and-forget rule).
- `pi.exec` timeout 5 s so a hung notification daemon cannot stall `agent_settled` handlers.
- Duplicate suppression: remember the last notified assistant message id; `agent_settled` firing again without a new assistant message (another extension's run, `/reload`) sends nothing.
- `session_shutdown`: nothing to clean up (no child kept alive, no temp files). Reset `lastNotifiedId` and `warned` on `session_start` so a resumed/new session behaves fresh.

---

## 4. Implementation steps

Each step names its verification. Do them in order.

1. **Scaffold `extensions/notify/index.ts`** with the default-export factory, exported `classify` and `buildNotification`, and the env accessors. No hook yet.
   → verify: `bun run check` passes.
2. **Write the scratch test first** (`$SCRATCH/notify-test.ts`, not committed) that imports the two pure functions and asserts the table in §3.3/§3.4: error beats question mark, aborted → skip, trailing `?` → question, multi-line success body truncated at 200 chars, error body uses `errorMessage`.
   → verify: `bun $SCRATCH/notify-test.ts` fails on the empty stubs, then passes once step 3 is done.
3. **Implement `classify`, `buildNotification`, `lastAssistantMessage`** (copy the branch walk from `extensions/tts/index.ts`, extend it to return `stopReason` and `errorMessage`).
   → verify: scratch test green; `bun run check` clean.
4. **Wire `agent_settled`, `session_start` reset, and the exec call** with the failure policy from §3.6.
   → verify (success): `pi --no-session -ne -nc -ns -np -e extensions/notify/index.ts -p "reply with exactly: ok"` shows a low-urgency "pi (…): done" popup.
   → verify (question): same command with `-p "ask me one short clarifying question about my project and stop"` shows a persistent "pi (…): question" popup whose body is the question.
   → verify (error): same command with `VELOX_API_KEY=invalid` (or an unknown model via `--model`) shows a critical "pi (…): error" popup with the HTTP error text.
   → verify (skip): in the TUI, start a long reply and press Escape; no popup.
   → verify (missing binary): `NOTIFY_COMMAND=/nonexistent pi -e … ` in the TUI shows one yellow `notify:` warning and no crash; a second run shows no second warning.
   → verify (dedupe): with `tts` also loaded (`TTS_AUTO_SPEAK` off), one reply produces one popup.
5. **Write `extensions/notify/README.md`** in the same shape as `extensions/tts/README.md`: usage, behaviour (the three outcomes and the `?` heuristic, aborted-is-skipped), env table, macOS note pointing at §7.
6. **Update repository docs.** `README.md` plugin table gets a `notify` row. `AGENTS.md`: bump "eight" to "nine" extensions, add the tree entry, a WHERE TO LOOK row, and one UNIQUE STYLES bullet ("notify is event-driven only: `agent_settled` → classify last assistant message → `notify-send`; aborted runs are silent; failures warn once"). Also add the new spec to the `.agents/specs/` row.
   → verify: `git diff` touches only `extensions/notify/`, `README.md`, `AGENTS.md`, and this spec.
7. **Final gate.** `bun run check`; re-run the step 4 success and error checks once more from a clean shell.

Estimated size: ~120 lines of TypeScript, ~60 lines of README.

---

## 5. Verification summary (definition of done)

- [ ] `bun run check` clean.
- [ ] Scratch assertions for `classify`/`buildNotification` pass (kept in the scratch directory; noted in `AGENTS.md` NOTES as ad-hoc, like skill-state's).
- [ ] Manual popups observed for success, question, error; none for abort; one warning for a missing binary.
- [ ] Works in print mode (`-p`) and TUI.
- [ ] No new dependencies, no build step, no secrets in output (error bodies come from `errorMessage`, which Pi already shows on screen).

---

## 6. Risks and open decisions

| Item | Decision / mitigation |
| --- | --- |
| `?` heuristic misses questions not on the last line | Accept. A missed question still yields a `done` popup. Revisit only if it bothers in practice; next step would be also checking the last sentence rather than last line. |
| Reply ends with a rhetorical `?` | Classified as question. Acceptable false positive; only changes icon/persistence. |
| Body leaks something the user considers private onto the lock screen | Body is a 200-char teaser of text already on the user's screen. If this matters later, add `NOTIFY_BODY=0`; not now. |
| `agent_settled` fires for runs started by another extension (e.g. skill-state's queued result message) | Dedupe by assistant message id handles repeats; a genuinely new assistant reply from such a run is a legitimate "session stopped" and gets a popup. |
| Notification daemon absent (SSH session, headless CI) | `notify-send` exits non-zero → one warning, then silence. No retries, no auto-install (matches the LSP/CodeGraph rule). |

---

## 7. macOS research (not implemented)

Question asked: can we send macOS notifications? **Yes, with caveats.** Options, in order of preference for a follow-up:

1. **`osascript -e 'display notification "body" with title "pi" subtitle "done"'`**. Ships with macOS, no install. Limitations: no urgency/icon control (the three outcomes would be told apart via `subtitle` and an optional `sound name`, e.g. `Glass`/`Basso`/`Funk`); the notification is attributed to "Script Editor", and on macOS 13+ the user must allow notifications for Script Editor (or the terminal app) once in System Settings. Body/title must be escaped for AppleScript string literals (`"` and `\`), or passed via `osascript -e … -- args` and `item 1 of argv`.
2. **`terminal-notifier`** (Homebrew). Proper app attribution, `-sound`, `-group` for replacement, `-open`/`-execute` actions. Extra install, so second choice.
3. **Terminal escape sequences** (OSC 9 in iTerm2/WezTerm/kitty/Ghostty, OSC 777 in some). Cross-platform and no binaries, but depends on the terminal, does not work through Pi's TUI without writing raw bytes to the tty, and cannot express urgency. Noted only as an alternative.

Follow-up plan when wanted: add a `platform()` switch in the same `index.ts`: `darwin` → build an `osascript` argv, else → `notify-send`. Until then `NOTIFY_COMMAND` is "same `notify-send`-style argv, different binary": it suits a wrapper script that translates the flags, not `terminal-notifier` directly. The README says so.
