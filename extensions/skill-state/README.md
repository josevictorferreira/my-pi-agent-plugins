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
/state-cancel
```

- `--skill <path>`: markdown file (≤ 4 KB) used verbatim as the spec `P`. Default is the built-in inspect → plan → edit → test → repair workflow in `workflow.ts`.
- `--max-steps N`: step cap, default 40.
- One run at a time; a second `/state-run` while one is active is refused.
- The run uses the session's current model at `temperature: 0`, with no provider thinking (reasoning is textual, as in the paper's Appendix A.4).
- `/state-cancel` or session shutdown aborts the run and kills any running child process.

## Action vocabulary

Every path is resolved under the Pi working directory; paths that escape it
produce an error observation, not a crash.

| Action | Semantics |
| --- | --- |
| `search_files {pattern, glob?}` | `grep -rnE` under the repo root, excluding `.git` and `node_modules` |
| `read_file {path, offset?, limit?}` | numbered window of a file; truncation notice tells the model how to page |
| `write_file {path, content}` | create or overwrite |
| `patch_file {path, oldText, newText}` | replace exactly one occurrence; 0 or 2+ matches is an error |
| `exec_shell {command, timeoutMs?}` | `sh -c` in the repo root; default 30 s, max 120 s |
| `git_diff {paths?}` | uncommitted diff |
| `finish {outcome, summary}` | end the run with `completed` or `cannot_complete` |

## State schema

```
runtime-owned: version, step, objective, inspectedFiles, changedFiles, checks (last 5 exec_shell results)
model-owned:   status, plan[], hypotheses{}, facts{}, blockers[]
```

Merge semantics (stated in the prompt): `facts` and `hypotheses` merge by key
and `null` deletes; `plan` and `blockers` are replaced whole; patching a
runtime-owned key is a validation error that names the key. Bounds after merge:
24 facts (values ≤ 300 chars), 12 hypotheses, 15 plan/blocker items, 6 KB total.
An invalid or over-bound reply is rejected, the state is left untouched, and the
same `(P, Σt, Ot)` prompt is re-sent with the error list appended, at most twice
(rollback-retry, paper §7). A third rejection fails the run.

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
