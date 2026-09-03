# skill-state

A Pi extension that runs a long-horizon software-engineering objective with the
**SKILL.state** runtime (Badhe et al., *SKILL.state: Scalable Long-Horizon Agent
Skills*, arXiv:2608.26263v2) instead of Pi's append-only conversation.

Each step the model sees exactly three things and nothing else:

| Symbol | What it is | Bound |
| --- | --- | --- |
| P | frozen skill spec (built-in SE workflow or a `--skill` markdown file) | ≤ 4 KB |
| Σt | small JSON execution state owned by the runtime | ≤ 6 KB |
| Ot | the latest observation only | ≤ 200 lines / 8 KB |

It replies with free-form reasoning followed by one fenced JSON block holding a
`state_patch` and one `action`. The reasoning is discarded, the patch is merged
(`Σt+1 = Σt ⊕ ΔΣt`), the action is executed, and its output becomes `Ot+1`.
Previous observations, actions and reasoning never re-enter the prompt, so the
prompt size is independent of the step count and cumulative tokens grow linearly.

## Commands

```
/state-run [--skill <path>] [--max-steps N] <objective>
/state-resume [--list] [--run <runId>] [--max-steps N] [note for the model]
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
- `--max-steps N`: step cap, default 250. Per-step cost is flat, so a large default costs nothing when the run finishes early; the phase rules below keep the model from spending it on inspection.
- One run at a time; a second `/state-run` while one is active is refused.
- Every prompt tells the model the current step and the cap. **Phases and progress are enforced by the runtime, not just requested by the spec.** Rejected replies get the rollback-retry treatment, so the loop forces the transition the same way it forces schema compliance (prose rules alone were not followed by the models tested; validation errors were, on the first retry, every time):
  - after a third of the budget, and never later than step 30, a patch that leaves `status` at `inspecting` is rejected;
  - `planning` requires a non-empty `plan` and lasts at most 2 steps, then `status` must be `editing`, entered with a plan (items are removed as they are done, so the plan may be empty later);
  - in `editing`, after 3 read-only actions (`read_file`, `search_files`, `exec_shell`, `git_diff`) without a write, the next action must be `write_file`, `patch_file` or `finish`;
  - `testing` requires at least one changed file.
  The runtime tracks this in two runtime-owned state fields, `statusSince` and `readsSinceWrite`, which the model sees but cannot patch.
- **Budget guidance.** Single-file fixes finish in 5 to 15 steps. A multi-file feature in a real application has needed 60 to 100. The default of 250 leaves room for repair cycles; lower it with `--max-steps` when you want a hard stop.
- The built-in spec asks for `cannot_complete` only when the objective needs information no action can obtain (URLs, production data, decisions only the user can make). Something the objective asks to add and that does not exist yet is the work, not a blocker.
- An identical `read_file` or `search_files` repeated with no intervening write is still executed, but its observation is prefixed with a note saying it already ran at step *k* and nothing changed. Writes clear that memory.
- The run uses the session's current model with no provider thinking (reasoning is textual, as in the paper's Appendix A.4). No sampling temperature is sent by default because some upstreams reject the parameter; set `SKILL_STATE_TEMPERATURE=0` to reproduce the paper's decoding on a model that accepts it.
- `/state-cancel` or session shutdown aborts the run and kills any running child process.
- **Recovery.** Σ is the run's entire memory, so a run that fails or is cancelled is checkpointed (spec, state, last observation, token totals) both as a `skill-state-checkpoint` session entry and as a file under `~/.pi/agent/skill-state/<working-directory>/<runId>.json`. The file store is independent of Pi's session persistence, so a run can be resumed from any later Pi session in the same directory: `/state-resume --list` shows the checkpoints for the directory, `/state-resume --run <runId>` picks one, and plain `/state-resume` takes the run from this process, then this session, then the newest file. A run that completes deletes its file. `/state-resume` continues from that state with whatever model is currently selected: switch with `/model` first if the previous one is misbehaving. Pass a larger `--max-steps` when the run stopped on the step cap. Any other text after the command is delivered to the model as an operator note in the first observation of the resumed run, which is how you answer a `cannot_complete` blocker (for example: `/state-resume --max-steps 60 fail_fast does not exist yet; add it to the workflow config and proceed to planning`). Resuming after `cannot_complete` with no note and no new budget reproduces the same conclusion. This is the paper's "zero-step state recovery" (Table 3) used operationally.
- **Provider errors.** A failed model call is retried up to 4 times with 2 s / 8 s / 20 s backoff (proxies with cold starts have been observed to need 10+ s). If it still fails, the run stops and is checkpointed rather than losing its state.
- Each `skill-state-step` entry records why rejected replies were rejected (`rejections`) and how many provider retries happened, so a run with many retries can be diagnosed from the transcript (expand the entry).

## Action vocabulary

Every path is resolved under the Pi working directory; paths that escape it
produce an error observation, not a crash.

| Action | Semantics |
| --- | --- |
| `search_files {pattern, glob?}` | `git grep -nIE --untracked` from the working directory, so ignored files (logs, build output, vendored trees) never reach the model; plain `grep -r` outside a git work tree. Up to 80 matching lines are shown in full; above that the model gets a per-file match map (top 40 files) and is asked to narrow the pattern |
| `read_file {path, offset?, limit?}` | numbered window of a file; truncation notice tells the model how to page. A missing path returns the entries of the nearest existing directory so the model can correct it |
| `write_file {path, content}` | create or overwrite |
| `patch_file {path, oldText, newText}` | replace exactly one occurrence; 0 or 2+ matches is an error |
| `exec_shell {command, timeoutMs?}` | `sh -c` in the repo root in its own process group; default 30 s, max 120 s. Timeout and cancel kill the whole group. The step settles when the shell exits, not when its stdio closes, so a daemon started by the command (a database server, a dev server) cannot hang the run; the observation says the process was left running |
| `git_diff {paths?}` | uncommitted diff |
| `finish {outcome, summary}` | end the run with `completed` or `cannot_complete` |

## State schema

```
runtime-owned: version, step, objective, inspectedFiles, changedFiles, checks (last 5 exec_shell results)
model-owned:   status, plan[], hypotheses{} (short free text), facts{}, blockers[]
```

Merge semantics (stated in the prompt): `facts` and `hypotheses` merge by key
and `null` deletes; `plan` and `blockers` are replaced whole; patching a
runtime-owned key is a validation error that names the key. Bounds after merge:
24 facts (values ≤ 300 chars), 12 hypotheses (values ≤ 200 chars), 15 plan/blocker items, 6 KB total, plus the phase rules above.
An invalid or over-bound reply is rejected, the state is left untouched, and the
same `(P, Σt, Ot)` prompt is re-sent with the error list appended, at most twice
(rollback-retry, paper §7). A third rejection fails the run.

## Debugging a run: the per-run log

Every run writes a JSONL trace to `~/.pi/agent/skill-state/<working-directory>/logs/<runId>.jsonl`, appended synchronously as the run goes, so a hang or crash leaves the trail up to that point. A resumed run appends to the same file. The run summary, the result message and the failure notice all name the path. Records:

| `type` | Contents |
| --- | --- |
| `run_start` | run id, objective, budget, model, spec, cwd, `resumedFrom` |
| `attempt` | one per model call that returned: full prompt, raw reply (with the discarded reasoning), usage, validation/merge errors (empty when accepted), duration |
| `provider_error` | one per failed model call: attempt number, error, duration |
| `step` | committed step: action, `state_patch`, state after merge, observation, telemetry |
| `run_end` | the run summary |

`/state-log` inside Pi shows the folder and the runs. Inspect a run with the bundled tool (`bun`, no build, run from this repo):

```
bun extensions/skill-state/tools/runlog.ts                       # runs for the current directory
bun extensions/skill-state/tools/runlog.ts <runId>               # step table and summary
bun extensions/skill-state/tools/runlog.ts <runId> --rejections  # why replies were rejected
bun extensions/skill-state/tools/runlog.ts <runId> --step 12     # patch, action, observation, state after step 12
bun extensions/skill-state/tools/runlog.ts <runId> --step 12 --prompt|--reply [--attempt K]
```

`--cwd <dir>` looks at another project's logs. Size is roughly 20 to 30 KB per step.

## What lands in the Pi session

- `skill-state-step` custom entry per step: prompt/state/observation bytes, token usage, retries, re-read count, duration. Rendered as one line in the transcript, expandable to the full JSON.
- `skill-state-run` custom entry at the end with the run summary table.
- Both are custom entries and are **never sent to the LLM**.
- One `skill-state-result` custom message (≤ 1 KB: outcome, summary, changed files, last checks, token totals) is queued for the outer conversation with `deliverAs: "nextTurn"`. It enters context only when you next speak; no turn is triggered. This is the only way the run affects the outer agent's context, whatever the step count.

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
this as `reReadCount` in telemetry and the built-in spec asks the model to write
salient facts before leaving a file. Expect more steps than a history-based
agent on the same objective; the saving is in tokens per step, not in steps.

## Files

| File | Role |
| --- | --- |
| `index.ts` | commands, entry renderers, model binding, result message |
| `schemas.ts` | TypeBox schemas for state patch, actions, step response |
| `state.ts` | initial state, `⊕` merge with bounds and rollback, runtime-field updates |
| `prompt.ts` | prompt rendering (Appendix A.4 shape), last-fenced-JSON parser |
| `executor.ts` | repo-local actions, observation bounding, timeouts, abort |
| `workflow.ts` | built-in spec, `--skill` loader |
| `runner.ts` | Algorithm 1 loop, retry, telemetry, termination |
