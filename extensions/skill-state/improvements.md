# skill-state: findings from the recorded runs and proposed improvements

Date: 2026-09-03. Source data: every state-run persisted on this machine.

| Source | Runs | Steps | Notes |
| --- | --- | --- | --- |
| Pi session entries, glyph (real repo, `gandalf`) | 1 | 9 | Pre-fix run; died on a provider 404 |
| Pi session entries, glyph clone (`radagast`) | 4 | 93 | The three reproduction runs plus one 30-step run, before and after each policy change |
| Pi session entries, scratch repo (`radagast`, `gandalf`) | 3 | 12 | Small two-bug fixture |
| Full JSONL trace, scratch repo (`radagast`) | 1 | 7 | Only run with prompts and replies on disk |

Your interactive glyph runs (the 40-step, 9-step and 81-step ones) left no trace: they were the first thing in fresh Pi sessions, which Pi never flushes to disk, and they predate the run log. Everything below is from the runs above. Where a finding needs the full trace, it rests on one run and is marked as such.

## Findings

### 1. The model skips the reasoning section entirely

In the full trace, all 8 replies start directly with the fenced JSON block: zero characters of reasoning before it, every time. The prompt asks for "step-by-step reasoning (will be discarded)" first, as in the paper's Appendix A.4, and the paper calls intact within-step reasoning "crucial". `radagast` ignores the instruction. Output tokens per step were still 180 to 1,500, so the tokens go into long `facts` values and file contents, not into thinking.

Whether this hurts is untested here: the scratch task completed in 7 steps regardless. On glyph the model's decisions were poor (see 3 and 4), and no reasoning is one plausible cause.

### 2. Rejected replies are the runtime doing its job, but two rejection classes are avoidable

Across all runs, 15 rejections. Grouped:

| Cause | Count | Status |
| --- | --- | --- |
| Phase policy (inspect budget, planning limit, read-only streak, plan required) | 6 | Intended; every one was corrected on the next attempt |
| `hypotheses` value not in the old three-value enum | 1 shown, likely most of the 8 in the pre-fix glyph run | Fixed (free text) |
| `status` not one of the five allowed values | 3 in one scratch run | Fixed (error names the allowed values; rules list them) |
| `testing` demanded a plan after the model had correctly emptied it | 1 | Fixed |
| Reply was not JSON at all | 1 | Model fault, retry recovered |

The `status` case matters: the error text is TypeBox's "must be equal to constant", which does not say what the allowed values are, and neither the prompt rules nor the spec list them explicitly. The model has to guess. Each rejection costs a full extra prompt (about 1.5k to 2.5k input tokens).

### 3. Reads that return errors are a large share of inspection

In the glyph runs, 15 of 40 `read_file` observations were under 250 bytes, which at that size can only be an error (missing path, offset past end). That is 37% of file reads producing nothing usable, and it is the main driver of the 7 to 16 re-reads per run. The missing-file listing added today should cut this. At the time of the analysis telemetry did not record whether an action succeeded; it now does (`actionOk`, `observationKind`), so the effect is measurable from session entries and the log tool marks such steps.

### 4. Search hits skew towards documentation

The glyph repo has `features.md`, `plan.md`, `poc.html`, `spec.md` and skill files under `.agents/` that mention every product concept. With broad patterns they dominate the per-file map ahead of `app/` and `spec/`, and `inspectedFiles` fills with them (`.agents/skills/.../SKILL.md`, `features.md`, `plan.md` appear in every glyph run). The model then reads planning documents instead of code.

### 5. Fixed prompt overhead is over half of every prompt

From the full trace, a first-step prompt is 6,051 bytes: spec 3,343, action vocabulary plus rules plus response format 2,158, state 312, observation 224. Median prompt across glyph runs was 10.1 KB at 0.26 tokens per byte, so roughly 1,400 of a typical 2,600 input tokens are the same bytes every step. Over the 93 glyph-clone steps that is about 130k of the 303k input tokens. `cacheRead` was 0 in every run: Velox reports no prompt caching, so the repetition is paid in full. The prompt is already ordered for prefix caching (spec, vocabulary, rules first; state and observation last), which helps on providers that cache.

### 6. State growth will hit the 6 KB cap on long runs

State grew about 140 bytes per step in the glyph runs: 1.0 KB at step 1, 5.1 KB at step 30. With the default budget now 250, the 6 KB cap binds around step 40 and every later step must delete facts to add any, which is exactly the "premature overwrite" failure the paper reports for small models. The cap was taken from the paper's 5-field schemas on shelf and CTF tasks; source code needs more.

### 7. Wall time is dominated by the model, and varies 3x by model

Median step duration was 3.5 to 5.4 seconds on `radagast` and 17.5 seconds on `gandalf` for the same kind of steps. `patch_file` and `write_file` steps cost 10 to 12 seconds and about 3,000 output tokens because the model re-emits file content. Nothing in the runtime is slow: `search_files` and `read_file` execute in milliseconds.

### 8. Resuming a `cannot_complete` checkpoint without new input repeats the conclusion

Seen in your 39/40/41 sequence: same state, same blockers, the model finishes again at once. The operator note on `/state-resume` addresses this, but the runtime lets a note-less resume of a `cannot_complete` checkpoint start anyway.

### 9. The "budget exhausted" blocker is noise

Three of four `cannot_complete` runs list "step budget exhausted" as a blocker. The runtime knows that already. Real blockers, like "fail_fast config format not identified", get buried next to it.

### 10. Plans contain investigation items

In two glyph runs the first plan item was "Find workflow config / fail_fast references" or "Search for graph, step dependencies...". The policy accepts any non-empty plan, so a plan can be a to-do list of more reading. The read-only streak rule then has to force the edit.

## Improvements, ranked by expected value over cost

Status 2026-09-03: all ten implemented (see README for the resulting behaviour); typecheck and 108 behavioural checks pass; verified end to end on the scratch fixture (7 steps, 0 rejections) and on the glyph clone (30 steps, 3 policy rejections, dispatcher logic reached for the first time). Two further defects were found while verifying and fixed: the read-only counter carried over from inspection into `editing`, and plan items naming a command mid-sentence ("exec_shell: npm test") were rejected as vague.

What is built but **not yet measured**, because it needs runs that have not been done:

- Item 4 (12 KB state cap): the 30-step glyph run reached 4.7 KB, so the old 6 KB cap would not have bound yet. The comparison needs a run past step 40.
- Item 8 (`--reasoning required`): the flag and telemetry exist; the A/B comparison of step counts and rejection rates on the glyph objective has not been run.
- Item 10 (extension tools): the tools appear in the prompt and execute correctly in checks, but in the 30-step glyph run the model never chose a `tool` action, so their effect on inspection is unmeasured. CodeGraph was not available in the clone (no index).

1. **Name the allowed values in rejection errors and rules** (small). Turn "must be equal to constant" into "status must be one of inspecting, planning, editing, testing, repairing" by mapping the TypeBox `enum`/`const` error to the schema's literals, and list the five statuses in the state rules. Removes an avoidable rejection class. (Finding 2)

2. **Record action outcome in telemetry** (small). Add `actionOk: boolean` and `observationKind` (`ok`, `error`, `empty`) to each step entry so error rates and re-read causes are measurable from session entries, not only from full traces. (Finding 3)

3. **Rank code above documentation in search results** (small). In the per-file map, order directories by a fixed preference (source and test directories first, then everything else), and exclude `*.md`, `*.html` and `.agents/` from `inspectedFiles`. Alternatively support a `--search-glob` default per run. (Finding 4)

4. **Raise the state cap for source code work** (small, measurable). 12 KB and 40 facts, keeping value length at 300. Per-step prompt stays flat; the constant rises by at most 6 KB. Re-run the 30-step glyph reproduction and compare re-reads and facts kept. (Finding 6)

5. **Refuse a note-less resume of a `cannot_complete` checkpoint** (small). If the checkpoint ended with `cannot_complete` and neither a note nor a larger budget is given, say so instead of spending a step to hear the same answer. (Finding 8)

6. **Stop the model listing budget exhaustion as a blocker** (small). Spec wording: blockers are things outside the model's control; when the budget ends, put remaining plan items in `plan` and leave `blockers` for real obstacles. The runtime appends "budget exhausted at step N" to the summary itself. (Finding 9)

7. **Require plan items to name a file** (medium). Accept a plan item only if it contains a path-like token, and say so in the rejection. Turns "search for X" plans into "edit app/domain/execution/step_dispatcher.rb: ..." plans. Needs care for objectives whose first edit is a new file; a "create <path>" item satisfies it. (Finding 10)

8. **Measure the reasoning question instead of assuming** (medium). Add a `--reasoning required|optional` run flag: with `required`, a reply with no text before the JSON block is rejected once with "write your reasoning first". Compare step counts and rejection rates on the glyph reproduction with both settings. The paper's claim is worth checking on this model rather than either enforcing or dropping it blind. (Finding 1)

9. **Trim the fixed prompt** (medium). The built-in spec is 3.3 KB and repeats things the rules say. A 2 KB spec plus 1.5 KB of rules would cut about 500 input tokens per step, roughly 20% of a typical prompt, on providers without caching. Keep the order for prefix caching. (Finding 5)

10. **Give the inspect phase real tools** (large, touches other extensions). `codegraph_explore`, `lsp` and Context7 would replace many of the read and search steps that currently produce errors or documentation hits. Pi exposes the tool catalogue but not execution, so the sibling extensions must export their execute functions through a shared registry. Implemented: `tool-registry.ts` plus a one-line wrapper per read-only tool in the five sibling extensions. (Findings 3, 4)

## What this data cannot tell you

- Whether the phase policy improves outcomes on tasks other than the glyph objective. Every glyph run used the same objective and the same 21 or 30 step budget; the scratch task is too small to exercise the policy.
- Anything about `gandalf` after the first 9 steps, or about your 81-step run. Those runs need to be repeated with the run log in place.
- Accuracy in the paper's sense. No baseline and no scored environment, as stated in the README.

## How to get better data next time

- Start Pi, say anything to the assistant once so the session file exists, then `/state-run`. Or rely on the run log, which now writes regardless.
- After a run: `bun extensions/skill-state/tools/runlog.ts <runId> --cwd <project>` for the table, `--rejections` for what was rejected and why, `--step N --reply` for what the model actually wrote.
