# skill-state

A Pi extension that runs a long-horizon software-engineering objective with the
**SKILL.state** runtime (Badhe et al., *SKILL.state: Scalable Long-Horizon Agent
Skills*, arXiv:2608.26263v2) instead of Pi's append-only conversation.

Each step the model sees exactly four things and nothing else:

| Symbol | What it is | Bound |
| --- | --- | --- |
| P | frozen skill spec (built-in SE workflow or a `--skill` markdown file) | ≤ 4 KB |
| Σt | small JSON execution state owned by the runtime | ≤ 12 KB |
| Ft | current text of the files the model read or wrote most recently (up to 4, re-read from disk every step) | ≤ 8 KB |
| Ot | the latest observation only | ≤ 200 lines / 8 KB |

It replies with free-form reasoning followed by one fenced JSON block holding a
`state_patch` and one `action`. The reasoning is discarded, the patch is merged
(`Σt+1 = Σt ⊕ ΔΣt`), the action is executed, and its output becomes `Ot+1`.
Previous observations, actions and reasoning never re-enter the prompt, so the
prompt size is independent of the step count and cumulative tokens grow linearly.
`Ft` is this implementation's one addition to the paper's `(P, Σt, Ot)`: see
"Open files" below for why.

## Commands

```
/state-run [--skill <path>] [--max-steps N] [--reasoning required|optional] [--tools] <objective>
/state-resume [--list] [--run <runId>] [--max-steps N] [--reasoning required] [--tools] [note for the model]
/state-log [runId]
/state-cancel
```

## Where things live

| What | Path |
| --- | --- |
| Per-run trace (prompts, replies, rejections, states, observations) | `~/.pi/agent/skill-state/<working-directory>/logs/<runId>.jsonl` |
| Checkpoints of failed or cancelled runs | `~/.pi/agent/skill-state/<working-directory>/<runId>.json` |
| Step and run entries inside the Pi session (TUI only, never in model context) | the session file under `~/.pi/agent/sessions/` |

`<working-directory>` is the Pi cwd with every non-alphanumeric character replaced by `-`, the same scheme Pi uses for `sessions/`. `~/.pi/agent` moves with `PI_CODING_AGENT_DIR`. Inside Pi, `/state-log` prints the directory and lists the runs in it; `/state-log <runId>` prints one file's path. Every run summary, result message and failure notice also names its log path.

- `--skill <path>`: markdown file (≤ 4 KB) used verbatim as the spec `P`. Default is the built-in inspect → plan → edit → test → repair workflow in `workflow.ts`.
- `--reasoning required`: reject, once per step, a reply that has no reasoning text before the JSON block. Default `optional`: the paper's format asks for reasoning first, but the models tested skip it and still complete tasks, so this exists to measure the difference, not to enforce a belief. Telemetry records `reasoningChars` per step either way.
- `--tools`: offer the extension tools (below) to the run. Off by default: their vocabulary is 1.6 KB of every prompt and a 372-call run used them zero times.
- `--max-steps N`: step cap, default 250. Per-step cost is flat, so a large default costs nothing when the run finishes early; the phase rules below keep the model from spending it on inspection.
- One run at a time; a second `/state-run` while one is active is refused.
- Every prompt tells the model the current step and the cap. **Phases and progress are enforced by the runtime, not just requested by the spec.** Rejected replies get the rollback-retry treatment, so the loop forces the transition the same way it forces schema compliance (prose rules alone were not followed by the models tested; validation errors were, on the first retry, every time):
  - after a third of the budget, and never later than step 30, a patch that leaves `status` at `inspecting` is rejected;
  - `planning` requires a non-empty `plan` and lasts at most 2 steps, then `status` must be `editing`, entered with a plan (items are removed as they are done, so the plan may be empty later);
  - every plan item must name a file (a path or `name.ext`) or a command to run; "search for X" is inspection, not a plan;
  - in `editing`, after 3 actions that changed no file (`read_file`, `search_files`, `git_diff`, `tool`, **and a rejected `write_file`/`patch_file`**), the next action must be a write or `finish`; the counter starts at zero when `editing` is entered and is reset only by a write that actually changed a file (counting failed writes as writes disabled this guard entirely: `read_file → failed patch_file → …` reset it every other step, and it fired once in 346 steps). `exec_shell` does not count: running the checks after an edit is what the phase is for, and `read → read → rspec` tripped the gate on a run that then needed to re-read the one file its next edit touched. At the gate one `read_file` of the file named in the first plan item is still allowed, since the model cannot see the observation it read it in;
  - `editing`, `repairing` and `testing` end after 12 steps in which no file changed: the reply is rejected until the model changes phase or sends `finish`. One run spent 138 consecutive steps in `editing` re-sending a patch that could not apply, and nothing capped it. The count runs from the last change (or, before the first one, from the step the run left `inspecting`), **not** from the start of the phase: anchoring it on `statusSince` let an `editing`/`repairing` alternation zero it on every flip, which is what a model under a failing patch does, and one run changed status 12 times in 54 steps without the count ever passing 3;
  - `testing` requires at least one changed file, and runs checks only: a `write_file` or `patch_file` there is rejected with a pointer to `repairing` (one reply can change the status and carry the edit). It used to be exempt from every action policy, which made it the one phase with no budget of any kind — a run held 13 of 54 steps there and spent them on three reads and a patch.
  The runtime tracks this in four runtime-owned state fields, `statusSince`, `workSince`, `readsSinceWrite` and `lastWriteStep`, which the model sees but cannot patch.
- **Budget guidance.** Single-file fixes finish in 5 to 15 steps. A multi-file feature in a real application has needed 60 to 100. The default of 250 leaves room for repair cycles; lower it with `--max-steps` when you want a hard stop.
- The built-in spec asks for `cannot_complete` only when the objective needs information no action can obtain (URLs, production data, decisions only the user can make). Something the objective asks to add and that does not exist yet is the work, not a blocker.
- **Open files (`Ft`).** The paper's environments have a sufficient statistic the model can write into Σ (shelf contents, a flag). Source code does not: what a `patch_file` needs is the exact text, and models cannot carry that in `facts`. With only the latest observation in view, a run on a 14-failure Rails task read an 8-line model and its 11-line spec alternately for 11 steps because it wanted both at once, re-read one 44-line file twelve times, and needed 54 steps (22 of them re-reads) where a history-based agent needed 21 tool calls; another run re-read `PROMPT.md` every other step to remember the task. So the runtime keeps the files the model read or wrote most recently open (up to 4; with 2 a run rotating through a spec and the two models it compared thrashed the window for 15 steps): their current text is re-read from disk every step (a patch is visible immediately, so `patch → read → patch` becomes `patch → patch`) and shown under "Open files", most recent first, within 8 KB, minus whichever one is already the latest observation. A `read_file` whose lines are already in the prompt is rejected (soft) with a pointer to where the text is. The comparison is on effective line ranges, not on the arguments: a run asked for lines 1-30, 1-50 and 1-100 of a 44-line file in turn, and for 40-50 of a file shown whole. Lines outside what is shown, or another file, are fine. The windows are in the checkpoint, so a resumed run keeps them. `openBytes` in the step telemetry is the cost; `promptBytes` stays bounded (spec + state + open files + observation).
- **Finish guard.** `finish` with outcome `completed` is a claim about the checks, so it is rejected (soft) unless a file has changed, a test/build/lint command has run since the last change, and that command passed (exit 0 and no failure reported in its output). If a check with no file argument (the whole suite: `bundle exec rspec`, `npm test`) ran at any point in the run, that is the check that has to pass after the last change, not a single spec file. One run finished "completed" at step 3 having changed nothing; another with 13 of 14 failures still failing after checking a single spec file; a third with 7 after running the whole suite six times and then only one file. A run that never ran anything but targeted checks is held only to its last one. `cannot_complete` is always accepted.
- An identical `read_file`, `search_files` or `exec_shell` repeated with no intervening write is still executed, but its observation is prefixed with a note saying it already ran at step *k* and nothing changed (for a command: its result is the same, so the command is what to change; one run ran a mistyped rspec path three times and concluded the spec file did not exist). A test/build/lint command is matched with its output-format flags (`--format`, `--reporter`, `--colour`, `--verbose`) removed, since they change how a runner prints and not what it reports: one run put `rspec`, `rspec`, `rspec --format documentation` and `rspec --format progress` over a byte-identical tree and only the second was recognised as a repeat. Changing the formatter is what a model does when it doubts the answer it already has. Writes clear that memory. When the previous step was a failed `patch_file` on the same file the note instead says to copy `oldText` from the text below and *not* to retype it from facts: "record it in facts instead of repeating it" is right for structural knowledge and wrong for the one case the spec mandates re-reading for, and a run followed it into patching from its own mangled copy of the line it was looking at.
- An identical `write_file` or `patch_file` that already failed is rejected **before** it runs, with the earlier error (which quotes the file) attached, and counts as a malformed reply. It cannot succeed: the file has not changed — and that is re-checked against the file's mtime rather than assumed, so an edit from outside the run lifts the rejection. One run sent 22 distinct `oldText` values 158 times, one of them 30 times.
- **Prompt shape and caching.** The paper sends one user message. Here the byte-identical part (spec, action vocabulary, state rules — about 4 KB, 950 tokens) is sent as the system prompt and only the state, open files, observation and rejections vary, because that is where pi-ai places the provider's prompt-cache marker; the run id is passed as the cache session key and long retention is requested. Whether it is honoured is up to the provider: `cacheRead` in the telemetry and the run summary is the measurement. Measured on OpenRouter with `inception/mercury-2.5-preview`: 0 cached tokens on every call, also when the system prompt was sent twice in a row and when it was doubled to 1.9k tokens, while Pi's own agent loop on the same model got cache hits once its prefix passed about 9k tokens. Do not expect caching to pay for this design at these prompt sizes; the levers are steps and reasoning.
- **Thinking.** The run uses the session's current model and its current thinking level (`/thinking`). With `off`, reasoning is meant to be textual, as in the paper's Appendix A.4, and the "off" form is sent explicitly: pi-ai only sends OpenRouter's disable when the catalog says the model can turn reasoning off, and for `inception/mercury-2.5-preview` it says it cannot (`thinkingLevelMap.off` is null), so nothing was sent and the model's default applied. That default is heavy: 95k of one run's 105k output tokens were hidden reasoning, about 70 % of its cost, on a task where the naked agent's calls reasoned ~170 tokens each. The endpoint accepts `reasoning.enabled = false` all the same (0 reasoning tokens, measured), so `model.ts` puts it on the request when pi-ai left it out. Through a generic OpenAI-compatible proxy nothing can be sent and the model's default applies (`glm-5-3` via Velox spent about five of every six output tokens on hidden reasoning, which made steps take 30 s to 4 min). When the provider reports reasoning tokens they are recorded per step (`reasoningTokens`) and in the run summary; `replyChars` against `output` shows the gap otherwise. No sampling temperature is sent by default because some upstreams reject the parameter; set `SKILL_STATE_TEMPERATURE=0` to reproduce the paper's decoding on a model that accepts it.
- `/state-cancel` or session shutdown aborts the run and kills any running child process.
- **Recovery.** Σ is the run's entire memory, so a run that fails or is cancelled is checkpointed (spec, state, last observation, token totals) both as a `skill-state-checkpoint` session entry and as a file under `~/.pi/agent/skill-state/<working-directory>/<runId>.json`. The file store is independent of Pi's session persistence, so a run can be resumed from any later Pi session in the same directory: `/state-resume --list` shows the checkpoints for the directory, `/state-resume --run <runId>` picks one, and plain `/state-resume` takes the run from this process, then this session, then the newest file. A run that completes deletes its file. `/state-resume` continues from that state with whatever model is currently selected: switch with `/model` first if the previous one is misbehaving. Pass a larger `--max-steps` when the run stopped on the step cap. Any other text after the command is delivered to the model as an operator note in the first observation of the resumed run, which is how you answer a `cannot_complete` blocker (for example: `/state-resume --max-steps 60 fail_fast does not exist yet; add it to the workflow config and proceed to planning`). Resuming a `cannot_complete` checkpoint with no note and no larger budget is refused, because the same state produces the same answer. This is the paper's "zero-step state recovery" (Table 3) used operationally. The first observation of a resumed run says so: which step it resumes at, the phase the previous segment ended in, and how many steps it ran after its last file change. Without that line a resume simply repeats the dead segment — one did, for 96 steps.
- **Provider errors.** A failed model call is retried up to 4 times with 2 s / 8 s / 20 s backoff (proxies with cold starts have been observed to need 10+ s). If it still fails, the run stops and is checkpointed rather than losing its state.
- Each `skill-state-step` entry records why rejected replies were rejected (`rejections`) and how many provider retries happened, so a run with many retries can be diagnosed from the transcript (expand the entry).

## Action vocabulary

Every path is resolved under the Pi working directory; paths that escape it
produce an error observation, not a crash.

| Action | Semantics |
| --- | --- |
| `search_files {pattern, glob?}` | `git grep -nIE --untracked` from the working directory. Brace globs are expanded before the search (`{app,spec}/**` becomes two pathspecs), because neither git pathspecs nor `grep --include` expand them and the silent "No matches" that resulted was indistinguishable from ground truth; an unbalanced brace is an error observation, not an empty result. so ignored files (logs, build output, vendored trees) never reach the model; plain `grep -r` outside a git work tree. Up to 80 matching lines are shown in full; above that the model gets a per-file match map (top 40 files) and is asked to narrow the pattern. "No matches" for a pattern that looks like a file glob or a path (`*_spec.rb`, `spec/**/*_spec.rb`) says so and points at `find`/`ls` through `exec_shell`: runs sent such patterns for 10+ steps in a row and read every empty result as ground truth |
| `read_file {path, offset?, limit?}` | window of a file as `line│text` with padded line numbers and no space after the separator, so the prefix cannot blend into the indentation (with `N: ` a model copied 4-space code back at 2 and 0 spaces, seven patches in a row); the header says the text after `│` is exact. Truncation notice tells the model how to page. A missing path returns the entries of the nearest existing directory so the model can correct it |
| `write_file {path, content}` | create or overwrite |
| `patch_file {path, oldText, newText}` | replace exactly one occurrence. If there is no exact match, the lines are compared with leading and trailing whitespace ignored; failing that, with **all** whitespace removed, the last line of `oldText` allowed to be a prefix of its file line (a fact that was cut mid-line) — the rest of that file line is carried over rather than dropped. A unique match is patched with `newText` re-indented to the file and the observation says which rule matched. 2+ matches (any rule) is an error. Models lose whitespace *inside* a line, not just in front of it: `action:add_helper_step` for `action :add_helper_step` was 158 of 158 failed patches in one run, and `trim()` cannot see past it. No match returns the file where `oldText`'s first line occurs, numbered and exact; that line is located with the loosest comparison available (equal ignoring indentation, then ignoring all whitespace, then containment, then longest common prefix), because a wrong guess costs nothing and a missing one cost that run every one of its 158 error messages |
| `exec_shell {command, timeoutMs?}` | `sh -c` in the repo root in its own process group, with `pipefail` when the system's `sh` supports it (so `rspec … \| tail` reports rspec's exit code); default 30 s, max 120 s. Output that reports failures ("30 failures", `FAIL`, a Python traceback) after an exit code of 0 is flagged in the observation and in the check summary. The summary recorded in `checks` is the first line of the last 20 that names a failure, and only otherwise the last line — rspec's last line is its random seed, which is what two checks carried into every later prompt in one run. Only test, build and lint commands are recorded in `checks`; `sed`, `awk`, `grep`, `ls` and the like through `exec_shell` are reads. Timeout and cancel kill the whole group. The step settles when the shell exits, not when its stdio closes, so a daemon started by the command (a database server, a dev server) cannot hang the run; the observation says the process was left running |
| `git_diff {paths?}` | uncommitted diff |
| `tool {name, params}` | one of the read-only tools other extensions in this package share with state-run (see below); params are validated against the tool's own schema |
| `finish {outcome, summary}` | end the run with `completed` or `cannot_complete` |

### Extension tools

Pi lets an extension list other extensions' tools but not run them, so the sibling extensions in this package hand their read-only tool definitions to `tool-registry.ts` by wrapping the definition: `pi.registerTool(stateRunTool({ ... }))`. The registry lives on `globalThis`, because Pi may load each extension through its own module cache. Currently shared: `codegraph_explore`, `codegraph_node`, `codegraph_query` and `codegraph_impact`, `context7_resolve_library_id`, `context7_query_docs`, `lsp`, `web_search`, `web_fetch`, `hindsight_recall`. A tool is only in the registry if its own extension registered it in this session: CodeGraph registers on `session_start` and only when its binary is on PATH, the project is indexed, and the tool is in `CODEGRAPH_TOOLS` (default `explore,node`), so `/state-run --tools` in an unindexed project sees no `codegraph_*` at all. Writing tools (`hindsight_retain`) are deliberately not shared: edits stay with `patch_file`/`write_file` so change tracking and the phase policy keep working. The vocabulary section in the prompt is generated from the registry (name, first sentence of the description, parameter names and types), about 1 KB for the full set. Tools from third-party packages are not reachable.

## State schema

```
runtime-owned: version, step, statusSince, workSince, readsSinceWrite, lastWriteStep, objective, inspectedFiles (read with read_file; search hits do not count), changedFiles, checks (last 5 test/build/lint runs)
model-owned:   status, plan[], hypotheses{} (short free text), facts{}, blockers[]
```

Merge semantics (stated in the prompt): `facts` and `hypotheses` merge by key
and `null` deletes; `plan` and `blockers` are replaced whole; patching a
runtime-owned key is a validation error that names the key. Bounds after merge:
12 hypotheses, 15 plan/blocker items, 12 KB total, plus the phase rules above. The paper's 6 KB suited its shelf and CTF schemas; on source code the state grew about 140 bytes per step and hit 6 KB around step 40.
Facts are capped at 40 keys, but going over is not a rejection either: the oldest keys not written by the patch are dropped (key order is recency; rewriting a key refreshes it) and the "Runtime notes" line names them. At the cap every new fact needed a deletion in the same patch, and one run spent 8 of its last 10 attempts failing that.
A fact sent directly under `state_patch` instead of `state_patch.facts` (`{"state_patch": {"foo": null}}` for "delete foo") is moved into `facts` with a note rather than rejected; that shape was 14 of 24 rejections in one run. Runtime-owned keys and non-string values are still errors, and the error now says where facts belong.
Fact values are capped at 600 chars and hypotheses at 200, but an over-long value is cut, not rejected: the patch is accepted and the next observation opens with a "Runtime notes" line naming the key and its length. Models cannot count characters, and "value longer than 300 chars" was 14 of 25 rejections in one run. The cut is also marked in the value itself with ` [CUT]`, and the cap was raised from 300: at 300 a run split one 99-character source line across six keys, and a `…` at the end of a code fragment reads as prose, not as "this is no longer exact text" — it then patched from the cut value.
An invalid or over-bound reply is rejected, the state is left untouched, and the
same `(P, Σt, Ot)` prompt is re-sent with the error list appended (rollback-retry,
paper §7). Malformed or off-schema replies ("hard") get 3 attempts per step; bound
and phase-policy rejections ("soft", the reply was fine and the runtime asked for
a change) get 5, counted separately (hard rejections used to eat the soft budget too,
and soft/hard/hard/soft/soft ended a run). Exceeding either **discards the step**:
Σ is kept, the step is spent, and the next observation lists every rejection the
attempts got so the model can satisfy all of them at once. The log records it as a
`discarded_step` event. After 3 discarded steps in one run the run fails and is
checkpointed; before that change a single exhausted step killed a run at step 67 of
500 with 4 failing tests left and a one-line fix next.

## Debugging a run: the per-run log

Every run writes a JSONL trace to `~/.pi/agent/skill-state/<working-directory>/logs/<runId>.jsonl`, appended synchronously as the run goes, so a hang or crash leaves the trail up to that point. A resumed run appends to the same file. The run summary, the result message and the failure notice all name the path. Records:

| `type` | Contents |
| --- | --- |
| `run_start` | run id, objective, budget, model, spec, cwd, `resumedFrom` |
| `attempt` | one per model call that returned: full prompt, raw reply (with the discarded reasoning), usage, validation/merge errors (empty when accepted), duration |
| `provider_error` | one per failed model call: attempt number, error, duration |
| `discarded_step` | a step whose retries ran out: retries, hard rejections, last errors, usage; the state was kept |
| `step` | committed step: action, `state_patch`, state after merge, observation, telemetry (including `actionOk`, `observationKind`, `toolName`, `reasoningChars`) |
| `run_end` | the run summary |

`/state-log` inside Pi shows the folder and the runs. Inspect a run with the bundled tool (`bun`, no build, run from this repo):

```
bun extensions/skill-state/tools/runlog.ts                       # runs for the current directory
bun extensions/skill-state/tools/runlog.ts <runId>               # step table and summary
bun extensions/skill-state/tools/runlog.ts <runId> --rejections  # why replies were rejected
bun extensions/skill-state/tools/runlog.ts <runId> --step 12     # patch, action, observation, state after step 12
bun extensions/skill-state/tools/runlog.ts <runId> --step 12 --prompt|--reply [--attempt K]
```

`--cwd <dir>` looks at another project's logs. Size is roughly 20 to 30 KB per step. A resumed run appends to the same file; the table and `--rejections` print a `── resumed from step N ──` marker (with the idle gap) and a `── run ended ──` marker at each segment boundary. The `rsn` column is hidden reasoning tokens when the provider reports them, `reply` the characters of the accepted reply.

### Benchmarking without Pi

`tools/bench.ts` drives the same runner from a shell, so runs can be scripted and compared against other agents on the same task:

```
bun extensions/skill-state/tools/bench.ts --cwd <repo> --model openrouter/inception/mercury-2.5-preview \
    --thinking off --api-key-env OPENROUTER_API_KEY_BENCHMARK --log run.jsonl "Follow the @PROMPT.md instructions"
```

`--thinking` takes a Pi level or `unset` (send nothing, the model's default). Model metadata comes from Pi's `models-store.json` (`--models-store <path>`, default the agent directory's) or the built-in catalog. One line per step goes to stderr, the run summary as JSON to stdout with `estimatedCostUsd` from the catalog prices, and `--log` writes the same JSONL trace `runlog.ts` reads. The exit code is 0 only for a `completed` run.

The reply parser takes the last closed ```` ```json ```` block; failing that an unclosed ```` ```json ```` opener or a bare `{…}` object after the reasoning (both shapes carried valid replies and cost a retry each). A reply with neither is rejected with `no_json_block`.

An objective typed in quotes (`/state-run "fix the …"`) has the quotes stripped. `@path` references in it are inlined (up to 6 KB in total, missing files left as written), the way Pi inlines `@file` in a prompt: the objective is runtime-owned state and in every prompt, so the task text stays in view. Without this one run read `PROMPT.md` every other step to remember the task.

## What lands in the Pi session

- **A live panel above the editor while the run is going** (`ui.setWidget`, cleared when the run ends). A step can take minutes, so the panel pins what scrolls away: run id, step and budget, phase, files changed, checks run; what the run is doing *right now* (`thinking`, with the attempt number when a reply was rejected, or the action it is executing) and how long that has taken; the result of the previous step; and the first plan item. It repaints on every phase change and once a second, so the elapsed time keeps moving. The footer status line carries the same position in one line.
- `skill-state-step` custom entry per step, three lines:
  - `state-run 12 editing → patch_file app/models/editor.rb  1.6k→430 48s` — the action **with its target**, not just its type, plus tokens and wall time, and `rejected Nx` when the reply was re-asked;
  - `✓ Patched app/models/editor.rb lines 36-37 (2 → 3 lines)` — the first line of the observation, green or red. A shell command that ran and exited non-zero shows red: it ran, and it failed;
  - `editing → testing · facts registry_exact, -old_guess · plan 2 left · 2 changed` — what the accepted state patch did.
  Expanded (the tool-output expansion key, `/help` shows the binding) adds the model's reasoning for that step (the runtime discards it after parsing; this is the only place it is visible), each rejection, up to 12 lines of the observation, and the byte/token detail. The full prompt, reply, state and observation stay in the run log, which is what `tools/runlog.ts` reads.
- `skill-state-run` custom entry at the end with the run summary table, including a row per recorded check.
- Both are custom entries and are **never sent to the LLM**.
- One `skill-state-result` custom message (≤ 1 KB: outcome, summary, changed files, last checks, token totals, elapsed time, tool call and failed call counts) is queued for the outer conversation with `deliverAs: "nextTurn"`. It enters context only when you next speak; no turn is triggered. This is the only way the run affects the outer agent's context, whatever the step count.

## Measured

One task, `inception/mercury-2.5-preview` through OpenRouter, 14 failing rspec examples out of 31 in a Rails app (`Follow the @PROMPT.md instructions`), scored by `bundle exec rspec` afterwards. Costs are from the catalog prices ($0.04/M in, $0.15/M out).

| Runner | Thinking | Steps | Wall | Cost | Hidden reasoning | Suite |
| --- | --- | --- | --- | --- | --- | --- |
| before (2026-09-07), the run that prompted this | model default | 54 | 3m26s | $0.020 | 95k of 105k output tokens | 0 failures |
| before, two more seeds | default / off | 28 / 35 | 94s / 51s | $0.010 / $0.006 | 48k / 0 | 13 / 9 failures |
| after (open files, `@file` objective, finish guard) | medium | 18 / 20 / 22 | 91s / 93s / 107s | $0.010 / $0.009 / $0.010 | 41k / 39k / 43k | 0 / 0 / 0 failures |
| after | low | 48 / 50 | 114s / 117s | $0.012 / $0.014 | 13k / 15k | 0 / 0 failures |
| after | off | 27 / 34 / 40 | 57s / 67s / 79s | $0.006 / $0.008 / $0.009 | 0 | 0 / 7 / 0 failures |
| Pi's own agent loop, same model, for scale | medium | 43 tool calls | 73s | $0.018 (376k uncached + 466k cached input) | 6.6k | 0 failures |

Re-reads went from 22 of 54 steps to 0 in all but one "after" run (4 in one `low` run). At `off` this model skips the textual reasoning too and gets sloppy (rewrites a spec file, edits `rails_helper.rb`, patches runtime-owned keys); `low` or `medium` is the sane setting for it, and the cost is then mostly its hidden reasoning, about 2k tokens a step in this format against ~170 per call in Pi's tool-calling loop. A single seed says little: the same setting ranged 18 to 26 steps.

## What this reproduces from the paper, and what it does not

Reproduced, by construction and verifiable from the per-step telemetry:

- **Bounded per-step prompt** (paper Eq. 6): spec, state and observation are each byte-capped, so `promptBytes` varies only with observation/state content, never with the step index.
- **Linear cumulative cost** (Eq. 7): cumulative `input` tokens grow linearly in steps.
- **The mechanism** (§3): frozen spec, structured state as the only memory, latest-observation-only, textual within-step reasoning discarded, dictionary merge with null-delete, rollback-retry on invalid patches.

Not reproduced, and no numbers here should be read as evidence for them:

- **Benchmark accuracy** (Tables 1, 6–8): needs a deterministic scored environment and ReAct / Summary / LangGraph baselines under one harness. This extension reports success/failure and step counts only.
- **Noise robustness and zero-step state recovery** (Tables 2–3): inherited qualitatively, not measured.
- **Budget-matched controls** (Table 5): not measured.

Expected weak spot: paper §7 failure condition (2), "a correct state update
depends on an earlier observation whose relevance was not recognized when first
observed". Source code has no natural sufficient statistic the way shelves or
CTF flags do, so the model must re-read files it saw earlier. The runtime counts
this as `reReadCount` in telemetry, the built-in spec asks the model to write
salient facts before leaving a file, and the open-files window (`Ft`) removes
the most common case, the file about to be patched. Expect more steps than a
history-based agent on the same objective; the saving is in tokens per step,
not in steps, and on a task small enough to fit in one context window a
history-based agent with prompt caching can cost the same or less.

## Files

| File | Role |
| --- | --- |
| `index.ts` | commands, entry renderers, result message |
| `model.ts` | model binding: system prompt / user message split, thinking level, explicit reasoning-off for OpenRouter |
| `schemas.ts` | TypeBox schemas for state patch, actions, step response |
| `state.ts` | initial state, `⊕` merge with bounds and rollback, runtime-field updates |
| `prompt.ts` | prompt rendering (Appendix A.4 shape plus open files), last-fenced-JSON parser |
| `openfiles.ts` | the open-file windows: bookkeeping, rendering within 8 KB, identical-window check |
| `executor.ts` | repo-local actions, observation bounding, timeouts, abort |
| `workflow.ts` | built-in spec, `--skill` loader |
| `runner.ts` | Algorithm 1 loop, retry, telemetry, termination |
| `tools/runlog.ts` | inspect a run log |
| `tools/bench.ts` | run the runner from a shell for benchmarks |
