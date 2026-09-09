# skill-state: findings from run `sr-mtrd4n6r` and proposed improvements

Date: 2026-09-08. Source: the only run log on this machine,
`/tmp/pi-sandbox-interactive/.pi/agent/skill-state/-home-josevictor-Workspace-ai-workspace-benchmarks-rails-inventory-system-worktrees-interactive-interactive-benchmarks-rails-inventory-system/logs/sr-mtrd4n6r.jsonl`
(887 KB, 112 events: 1 `run_start`, 54 `step`, 56 `attempt`, 1 `run_end`). That file no
longer exists: a later `bin/benchmark-interactive` teardown deleted the sandbox on
2026-09-09, mid-way through implementing the fixes below. The rows quoted here were
extracted while it was readable; §5 is now guarded against.

Model `openrouter/inception/mercury-2.5-preview`, objective *"Follow the @PROMPT.md
instructions"* on the `rails-inventory-system` benchmark, `maxSteps` 500, extension tools
off. The run started at 14:55:36 UTC on 2026-09-07, seven minutes after `41a629d`, so it
reflects the code at that commit — `df32551` landed mid-run and `7a66280` (open file
windows) after it. Every finding below was re-checked against HEAD.

**This is a success run**, which makes it a different instrument from the one in
`improvements_3.md`. 54 steps, `bundle exec rspec` at 31 examples / 0 failures, four files
changed, `completed`. 3m26s wall, 179,984 ms of it model latency (87%). What is left to
find is waste inside a working run, not a rescue.

| | |
| --- | --- |
| Steps / attempts | 54 / 56 (2 rejections, both on step 18) |
| Input / output tokens | 117,397 / 105,404 |
| Hidden reasoning | 94,993 (90.1% of output) |
| `cacheRead` | 0, on all 56 attempts |
| Prompt | 2,174 tokens avg, 4,795 max; 8,766 bytes avg, 17,494 max |
| Re-reads | 22 of 54 steps |
| Checks run | 12 `rspec` invocations |
| Phase segments | 12 (4.5 steps per segment) |

## Already fixed at HEAD

Worth recording, because this log is the evidence those fixes were aimed at real behaviour
and none of it should be re-reported as new:

1. **The read ping-pong.** Steps 7–17 alternate `app/models/inventory_item.rb` (8 lines)
   and `spec/models/inventory_item_spec.rb` (11 lines) for eleven consecutive steps, then
   `order_item.rb` is read twelve more times: 22 re-reads in 54 steps, 41% of the run.
   `openfiles.ts` keeps four windows open with refreshed text and rejects a read of lines
   already shown. The header comment in that file describes this exact run.
2. **`search_files` on a file name.** Step 4 searched `spec/models/inventory_item_spec.rb`
   as a content regex and got "No matches" for a file that exists (it is read at step 7);
   step 5 sent `.*_spec\.rb$` with a `**/*_spec.rb` glob and got the same. Three steps to
   discover that `/.*/ in spec/**/*` is how you list a directory. `formatSearch`
   (`executor.ts:271`) now detects a glob-like or path-like pattern and names `find` / `ls`.
3. **Runtime-owned keys in `state_patch`.** Step 18 attempt 1 was rejected for
   `"changedFiles": [...]`. The patch-shape repair in `schemas.ts` now drops those with a
   notice. This matters more than it looks — see finding 1 below.
4. **Hidden reasoning at 90% of output.** 94,993 of 105,404 output tokens, ~1,700 per
   attempt to decide a single `read_file`, against 10,411 tokens of visible reply.
   `index.ts:94` now defaults the session to `thinking: "off"` and `model.ts` forces
   `reasoning: { enabled: false }` on OpenRouter-format models whose catalog entry claims
   they cannot disable it. At Mercury's $0.15/M output that was ~70% of the run's cost.

## Findings

### 1. A plan item sent as an object is a hard rejection, and the rejection made the model throw away a correct edit

Step 18 is the most expensive step in the run: 3 attempts, 7,044 reasoning tokens, 15.2 s.
The sequence is worse than the cost suggests.

Attempt 1 already had the right answer:

```json
"action": { "type": "patch_file", "path": "app/models/inventory_item.rb",
  "oldText": "  validates :quantity, presence: true",
  "newText": "  validates :quantity, presence: true, numericality: { greater_than_or_equal_to: 0 }" }
```

That is the edit the run eventually lands, and it was rejected for the cosmetic
`changedFiles` key alone. At HEAD that attempt passes.

Attempt 2 then sent:

```json
"plan": [ { "path": "app/models/inventory_item.rb", "change": "Add validates :quantity, …" } ]
```

→ `/state_patch/plan/0: must be string`. Still a hard rejection at HEAD: `plan` is
`Type.Array(Type.String())` (`schemas.ts:36`) and nothing repairs the shape. And in
re-deciding, the model did not just fix the plan — it **downgraded its own action**, moving
`status` back to `planning` and replacing the patch with a `read_file` of the file it had
just read. Attempt 3 abandoned the edit entirely and sent `git_diff`, a no-op. The patch
finally landed at step 20, after another `read_file` at 19.

A rejection is not a free retry. The model rewrites the whole response, and under a
schema error it rewrites the action more conservatively. Two of the three attempts on this
step produced a worse action than the one that was rejected.

**Fix (small).** Repair object items in `plan` and `blockers` the way stray facts are
repaired: `{path|file, change|description}` → `"path: change"`, a single-string object →
its value, with a notice. Reject only what cannot be flattened. `isConcretePlanItem`
already validates the result, so a bad flattening still fails on its merits.

### 2. Nothing budgets `testing`, so it is a guard-free phase

`actionErrors` (`state.ts`) returns `[]` for any status that is not `editing` or
`repairing`, and `phaseErrors` budgets only `inspecting` (≤ 30 steps) and `planning`
(≤ 2 steps). `testing` has no read-streak limit, no stall limit and no step cap.

This run spent 13 of 54 steps there, and they were not all checks:

| Step | Status | Action |
| --- | --- | --- |
| 34 | testing | `read_file app/models/order_item.rb` |
| 49 | testing | `read_file app/services/order_confirmation_service.rb` |
| 51 | testing | `read_file app/services/order_confirmation_service.rb` |
| 52 | testing | `patch_file app/services/order_confirmation_service.rb` |

It worked out here. But a model that leaves `status` at `testing` has an unbounded budget
for reads and writes, which is exactly the loop `READS_BEFORE_EDIT` and
`EDIT_STALL_STEPS` exist to end. The spec already states the intended shape: a failing
check means record the failure in facts, fix, return to testing — i.e. a write belongs to
`editing`/`repairing`, never to `testing`.

**Fix (small).** Reject `write_file`/`patch_file` while `status` is `testing` with
*"a check failed: set status to \"repairing\", record what failed in facts, then edit"*, and
include `testing` in the stall check with its own (looser) bound. Either half closes the
hole; the first is truer to the phase model.

### 3. A phase flip resets the edit-stall counter, so `editing ⇄ repairing` still defeats it

`actionErrors` computes

```ts
const stalled = next.step + 1 - Math.max(next.statusSince, next.lastWriteStep) - 1;
```

and `merge` sets `next.statusSince = state.step + 1` on every status change. `Math.max`
takes the *larger* of the two, so any status change zeroes the stall count — including a
change between the two statuses the check itself covers.

This run changed status 12 times in 54 steps; `stalled` peaked at 3, against a threshold
of 12. That is honest here (writes were landing). The problem is latent: the 138-step
no-progress stall in `improvements_3.md` §4 that motivated `EDIT_STALL_STEPS` would still
not be caught today if it alternated `editing` → `repairing` every eleven steps, and
alternating on rejection is exactly what a model under a repeated patch failure does.

**Fix (one line).** Drop `statusSince` from the stall term and measure from
`lastWriteStep`, falling back to the step the run first left `inspecting`. Progress is a
file changing, not a phase beginning. The two are already tracked separately.

### 4. The same check under a different formatter flag reads as a different command

`seenReads` keys on `JSON.stringify(action)` (`runner.ts:617`), so the
*"this exact command already ran at step N and no file changed since"* note fires only on a
byte-identical command. Four steps ran the same suite over a byte-identical tree
(`lastWriteStep` = 31 for all of them):

| Step | Command | Note fires at HEAD? |
| --- | --- | --- |
| 33 | `bundle exec rspec` | — |
| 35 | `bundle exec rspec` | yes |
| 37 | `bundle exec rspec --format documentation` | no |
| 39 | `bundle exec rspec --format progress` | no |

Twelve `rspec` invocations in 54 steps, 4–6 s each: roughly 55 s of a 206 s run, and at
least three of those runs could not have told the model anything new. Changing the
formatter is precisely what a model does when it distrusts an answer it has already been
given, so this is the shape the note should catch.

**Fix (small).** When `isCheckCommand(command)` is true, key the repeat note on the
command with output-format flags stripped — or skip the string comparison entirely and note
*"a check already ran on this tree at step N; its result is in `checks`"* whenever any check
ran since `lastWriteStep`. `state.checks` already carries the result to point at.

### 5. Smaller observations

- **`read_file offset: 9` on an 8-line file** (step 16) cost a step. The error message is
  right (*"has 8 lines; offset 9 is past the end"*); the model simply did not know the
  length. The open-files view at HEAD renders `total`, which likely removes this class.
- **`cacheRead` is 0 on all 56 attempts, and that is structural for this model.** The
  cacheable system prefix — spec, action vocabulary, state rules — is about 4 KB, roughly
  1k tokens, and Mercury on OpenRouter returned cache hits only past ~9k tokens of prefix.
  Open files enlarge the *user* half, not the cacheable prefix, so HEAD will not change
  this. `improvements_3.md` item 12 should be closed as not-achievable for this provider
  rather than left as pending work.
- **Phase segments average 4.5 steps.** `inspecting`×18, `editing`×19, `testing`×13,
  `repairing`×3, `planning`×1, across 12 segments: `testing → repairing → testing →
  planning → editing` between steps 21 and 26. The status field is being flipped rather
  than progressed through, which is what makes findings 2 and 3 reachable. Worth watching
  whether the open-files change reduces it (fewer forced re-reads should mean fewer
  bounces) before adding any transition rule.
- **Log retention is still the binding constraint on this whole exercise.**
  `~/.pi/agent/skill-state/` does not exist on this machine, so the glyph log behind
  `improvements_3.md` is gone the same way `improvements_2.md`'s was. The one analysed here
  survives only because `/tmp/pi-sandbox-interactive` happened not to be cleaned;
  `bin/benchmark-interactive` deletes it on exit. Nothing in three rounds of findings has
  been reproducible against its own source data. Copying the log out of the sandbox before
  teardown is a smaller change than anything else in this file and unblocks all of it.

## Improvements, ranked by expected value over cost

All six shipped on 2026-09-09. Verification is a replay of this run's own rows against the
changed guards, since the log itself was gone by then: 30 assertions covering the rejected
reply of step 18, all 54 steps through the new stall term, and the four `rspec` keys.

1. **Flatten object `plan`/`blockers` items instead of rejecting them** (small). Turns the
   run's single most expensive step into a notice, and stops a schema error from
   downgrading a correct action. (Finding 1)
   → `repairPatchShape` in `schemas.ts`, renamed from `relocateStrayFacts` and now three
   repairs. `{"path": …, "change": …}` becomes `"path: change"`: a path-like key leads, any
   other string follows. An object with no string in it still fails validation, and
   `isConcretePlanItem` still judges the result.
2. **Close the `testing` escape hatch** (small). Reject writes in `testing` and give the
   phase a stall bound; today it is the one phase with no budget of any kind. (Finding 2)
   → `actionErrors` rejects `write_file`/`patch_file` in `testing`, pointing at `repairing`
   and saying that one reply can change status and edit at once. `testing` is inside the
   stall check now as well. On this run that is one rejection, at step 52.
3. **Measure the edit stall from `lastWriteStep`, not `max(statusSince, lastWriteStep)`**
   (one line). Restores the guard against an `editing`/`repairing` alternation, which is
   how the 138-step stall would present today. (Finding 3)
   → The term is `max(lastWriteStep, workSince)`, with `workSince` a new runtime field
   holding the step the run first left `inspecting`. It anchors the count before any write
   lands, which `lastWriteStep` alone (0 there) cannot. At step 41 the stall now reads 10
   where it read 3. Checkpoints saved without the field get it backfilled on resume:
   `undefined` would make the term `NaN`, which is never over the threshold, i.e. the guard
   silently off for a whole run.
4. **Normalise check commands for the repeat note** (small). Catches the
   same-suite-different-formatter re-runs; ~3 wasted steps and ~15 s in this run.
   (Finding 4)
   → `checkCommandKey` in `executor.ts` strips `--format`/`--formatter`/`--reporter`,
   `--colour` and `--verbose`/`--quiet` before the repeat lookup, for check commands only.
   Long forms only: `-f` is a formatter to rspec and a makefile to make. Scope still
   distinguishes, so `rspec spec/models` stays separate from `rspec`.
5. **Preserve run logs out of the interactive sandbox** (small, outside this extension).
   Every round of findings so far has been unreproducible by the next one. (Finding 5)
   → `save_run_logs` in `bin/benchmark-interactive`, called before the `rm -rf`, copying to
   `runs/skill-state-logs/`. Not hypothetical: the log analysed above was destroyed by a
   later sandbox teardown *while these fixes were being written*, which is why the
   verification runs off extracted rows rather than the file.
6. **Close `improvements_3.md` item 12 (prompt caching) as not-achievable for Mercury**
   (bookkeeping). Measured: no hits below ~9k tokens of prefix; the cacheable prefix here is
   ~1k. (Finding 5)
   → Struck through there, with the measurement and the condition to re-open it.

The prompt's `STATE_RULES` states rules 2 and 3 too. A rule the model is rejected for
breaking but cannot read is a trap, and that paragraph is the only place it learns the
budgets.

## What this data cannot tell you

- **Whether the HEAD fixes work.** Every one of the four "already fixed" items is inferred
  from code, not measured: this log predates `7a66280`. The 22 re-reads, the three
  `search_files` misses and the 90% reasoning share are the baseline to re-measure, not
  evidence of an improvement.
- **Whether open files make the prompt too big.** `maxPromptBytes` was 17,494 here with no
  open-files block. `MAX_OPEN_BYTES` is 8 KB on top of that, and nothing in this log says
  what a 25 KB prompt does to Mercury's step latency or reply quality.
- **Anything about failure.** This run succeeded, its two rejections were both schema
  shape, zero patches failed to apply, and the whitespace matcher from
  `improvements_3.md` §1 was never exercised. The interior-whitespace question is still open
  on one model only.
- **Whether the phase machine helps at all.** 12 segments in 54 steps, and the statuses
  correlate poorly with what the actions do (`rspec` in `editing` at steps 39 and 43, a
  patch in `testing` at 52). A run with `status` pinned to one value would be the control,
  and it has not been run.

## How to get better data next time

- Re-run this exact objective on the same worktree at HEAD and compare against the four
  numbers above: steps (54), re-reads (22), reasoning share (90%), `rspec` invocations (12).
  `tools/bench.ts --thinking off` reproduces it without the sandbox.
- Copy the log before the sandbox dies:
  `cp -r "$SANDBOX/.pi/agent/skill-state/*/logs" <somewhere durable>` at the end of
  `bin/benchmark-interactive`.
- `bun extensions/skill-state/tools/runlog.ts sr-mtrd4n6r --step 18` shows the rejection
  cascade in finding 1 in full, including the correct patch that was thrown away.
