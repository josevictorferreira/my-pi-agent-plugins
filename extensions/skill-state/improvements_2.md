# skill-state: findings from the 2026-09-06 glyph run and proposed improvements

Date: 2026-09-06. Source data: the only run log on this machine since the run log landed,
`~/.pi/agent/skill-state/-home-josevictor-Workspace-glyph/logs/sr-mtpp8znz.jsonl` (1.8 MB),
plus its checkpoint file. Model `velox/glm-5-3`, budget 250, default spec, extension tools on,
`--reasoning` not set. The run was still live when this was written (snapshot taken at
13:21 UTC, 52 steps in); numbers below are from that snapshot.

| Segment | Steps | Ended by | Wall time |
| --- | --- | --- | --- |
| Run 1 (10:59 UTC) | 1 to 27 | step 28 rejected 3 times: fact value over 300 chars | 20 min |
| Resume 1, no note (12:11) | 28 to 49 | step 50 rejected 3 times: read-only streak, long fact, read-only streak | 30 min |
| Resume 2, no note (13:17) | 50 onward | live; first `rspec` at step 51, all 30 examples fail on a missing Postgres | ongoing |

Every finding below is from this single run and one model, so treat the rates as one sample.
Where the earlier `improvements.md` measured the same thing, the comparison is stated.

## Findings

### 1. Ten of fifteen patches failed, and the runtime told the model nothing useful

`patch_file` was used 15 times; 10 returned `oldText not found`. Seven of those were consecutive
attempts on the same method (`user_prompt` in `pi_agent_runner.rb`, steps 10 to 23), each
followed by a `read_file` of the same region to "get the exact text", then another failure.

The cause is visible in the log. The file has `def user_prompt` at 4 spaces (inside
`module Execution` / `class`), and the `read_file` observation shows that correctly
(`365:     def user_prompt`). The model copied it back at 2 spaces (step 10), then at 0 spaces
(step 12), and kept guessing. It never saw a diff, because the error is a single sentence:

```
Error: oldText not found in app/domain/execution/pi_agent_runner.rb; read the file and copy the exact text
```

The model's own diagnosis, recorded as a fact at step 25, blames the tool:
"read_file display omits leading whitespace in this repo; before patching, get exact bytes via
sed -n 'a,bp' FILE | cat -A". It then concluded `cat -A` collapsed whitespace too
("def and body both 1sp, impossible") and only succeeded at step 26 after writing an `awk`
command that prints the indentation width of each line as a number. In other words the model
built the observation format it needed, and it cost 17 steps.

Cost of the loop (steps 10 to 26): 776 seconds, 63k input and 53k output tokens, roughly a
third of the run. The same failure recurred on the spec file at steps 42, 44 and 46 (three more
failed patches) and on `step_inspector_spec.rb` at step 50, where the model again fell back to
`awk` with indentation counts.

Two things follow. First, `read_file`'s `N: ` prefix is a poor separator for a model that has to
reproduce leading whitespace: the prefix width varies with the line number and ends in a space
that merges visually with the indentation. Second, an exact-match `indexOf` with a one-line error
is the weakest possible patch tool; every mainstream agent edit tool matches whitespace-tolerantly
and reports the nearest candidate on failure.

### 2. Fact values over 300 chars are now the top rejection cause and killed run 1

25 rejected attempts across the run; grouped:

| Cause | Attempts | Notes |
| --- | --- | --- |
| Fact value over 300 chars | 14 | 301 to 430 chars; killed run 1 at step 28 (three attempts, three different keys, all too long) |
| Reply had no ```json block | 6 | 4 replies were prose only (model stopped after reasoning); 1 put the JSON inline with no fence; 1 opened a fence with no closing fence |
| Read-only streak in `editing` | 3 | Steps 50 (twice) and the fatal third attempt of resume 1 |
| Invalid JSON | 1 | Missing comma between two fact entries |
| Hypothesis over 200 chars | 1 | |
| Unknown key `action_note` in state_patch | 1 | |

Rejected attempts cost 82k input tokens, 70k output tokens and 18 minutes on their own.

The 300-char limit is the problem, not the model. The model cannot count characters; 12 of the
14 oversize values were between 301 and 371 chars, and the error does not say how long the value
was. Worse, the limit is a soft bound (the state is still valid JSON, the 12 KB cap is the real
guard) yet it is enforced by full rollback-retry, the same mechanism as a malformed reply. It
also interacts badly with the streak policy: at step 50 of resume 1, attempt 2 was a valid
`patch_file` that was thrown away because one fact was 301 chars, attempt 3 went back to a read
and the run died. Resume 2 hit the identical sequence and survived only because attempt 3
happened to be a write.

Compared with the 2026-09-03 analysis: `status`/`hypotheses` enum rejections are gone (fixed),
and phase-policy rejections dropped from 6 of 15 to 3 of 25. Bound errors on facts did not
appear then because runs were shorter and facts smaller.

### 3. The model uses `exec_shell` as its file reader

19 of 52 actions were `exec_shell`. Only 3 were checks (`node --check` at step 37, `rspec` at 51
and 52). The other 16 were `sed -n`, `awk`, `cat -A`, `grep -n`, `wc -l`, `ls` reads, all
motivated by finding 1. Consequences:

- `checks` in state and in the result message are the last five shell commands, so the run
  summary shown to the user reads "Last checks: ls ..., wc -l ..., sed ..., awk ..., grep ...".
  No check was a test until step 51.
- `exec_shell` counts against the read-only streak like `read_file`, which is right, but these
  reads bypass the duplicate-read note, the `inspectedFiles` record and the re-read counter.
- Two shell reads produced 8 KB observations (`cat -A` output at steps 30 and 34), the largest
  prompts of the run (22 KB, 10.9k input tokens).

### 4. Most billed output is invisible reasoning

The README states the run uses "no provider thinking". The log says otherwise for
`velox/glm-5-3`: visible reply text totals about 33k tokens (chars / 4) against 201k billed output
tokens, so roughly 5 of 6 output tokens never reach the runtime. Per attempt the ratio of billed
output to visible characters ranges from 0.3 to 12.4; step 42 attempt 1 was a 151-character
reply billed at 1,871 output tokens.

This is the wall-time driver. Median step took 32 seconds and the slowest steps were the ones
with the biggest ratios: step 36 (`write_file`, 248 s, 15,970 output tokens for a 7 KB file),
step 25 (211 s, 13,818 output tokens for a `sed` command), step 28 (180 s). Run 1 plus resume 1
took 50 minutes of wall time for 49 steps; the earlier analysis had 3.5 to 17.5 s per step.

`StepTelemetry.output` conflates the two, so this cannot be seen from session entries. The `usage`
object Pi returns may carry a reasoning-token field; the runtime does not record it.

### 5. Visible reasoning is present but the model skips the JSON block instead

Contrary to the 2026-09-03 finding ("the model skips the reasoning section entirely"), this model
writes reasoning before the block in 51 of 52 accepted steps (median 430 chars). The new failure
mode is the opposite: 4 of 6 `no_json_block` rejections are replies that end after the
reasoning ("Let me read that section." and nothing else), each costing a full prompt.

The other two are parser strictness: step 19 wrote the JSON inline after a sentence with no
fence at all, and step 45 wrote ```` ```json ```` glued to the end of a sentence with no closing
fence. Both replies contained a complete, valid `{"state_patch":...,"action":...}` object.

### 6. Rollback-retry gives three attempts regardless of what went wrong

`MAX_RETRIES = 2` treats "your JSON was malformed" and "one fact is 12 chars too long" the same,
and both segments of this run died on the third attempt of a step whose checkpoint was fine.
Each death cost the user a manual `/state-resume` and 36 to 52 minutes of idle time between
segments. The step-50 sequence shows the retries are not converging on anything: attempt 1 and 3
were the same policy violation with a different valid attempt in between.

### 7. The resume path worked, but the tooling hides segment boundaries

Both resumes appended to the same log and continued from the right step. `runlog.ts --rejections`
prints "step 28 attempt 1" twice and "step 50 attempt 1" twice with no marker that a resume
happened in between, and the table view has no row for `run_start`. Neither resume carried a
note, although the runtime's own error text was enough context both times.

### 8. Piped test commands hide failures from `checks`

Step 51 ran `bundle exec rspec ... 2>&1 | tail -n 40`. The output says "30 examples, 30
failures"; the recorded check says `code: 0`, because `sh -c` reports the exit code of `tail`.
Any check summary built from the exit code will call this a pass. The model appends `| tail` or
`| sed -n` to almost every command to stay under the observation cap, so this will be the common
case, not the exception.

### 9. Smaller observations

- The objective is stored with its surrounding quote characters (`"\"Take this workflow…\""`)
  because the user quoted it on the command line; it is echoed that way in every prompt.
- `search_files` at step 4 added 13 files to `inspectedFiles`, including `db/schema.rb`, three
  `db/*_schema.rb` files and a migration, none of which were ever read. `inspectedFiles` now
  means "matched or read", which weakens it as a "what I have looked at" signal.
- State grew from 6.1 KB at step 10 to 9.0 KB at step 49 (about 75 bytes per step in
  `editing`). The 12 KB cap would bind near step 90 at this rate, so the raise from 6 KB was
  necessary and sufficient for this run.
- No `tool` action was chosen in 52 steps although nine extension tools were listed in every
  prompt (about 1.2 KB of fixed prompt). The model used `grep`/`sed` instead. Same as the
  30-step run on 2026-09-03: still unmeasured, and now costing prompt bytes on every step.
- `cacheRead` was 0 on every step, as before.

## Improvements, ranked by expected value over cost

Status 2026-09-06: items 1 to 10 implemented; `bun run check` passes and 51 behavioural
checks (scratchpad script, not committed) cover the new paths. Replaying the seven failed
`user_prompt` patches from the log against the pre-run file: all seven now apply, re-indented
from 0 or 2 spaces to the file's 4, producing the code the model intended at step 10. Not done:
item 11 (needs two runs of the same objective to compare) and item 12 (conditional on what
items 1 and 2 do to the shell-read count). Both need runs that have not happened yet.

Deviations from the proposals below: item 2 uses the `│` separator and header note but not a
per-line indent count; item 4 keeps 3 attempts for malformed replies and gives bound and
policy rejections 5, without applying the last valid patch on failure; item 6 records the
failure in the check summary and the observation but keeps the real exit code.

1. **Whitespace-tolerant `patch_file` with a real error** (small, highest value). On an exact
   miss, retry the match with each line's leading whitespace stripped; if exactly one region
   matches, apply the patch there, re-indenting `newText` by the same delta, and say so in the
   observation ("matched at lines 365-376 with indentation adjusted by +2"). If nothing matches,
   report the closest region (first line of `oldText` found at line N) with its exact text so the
   next attempt has what it needs. Would have saved about 17 of 52 steps here. (Finding 1)

2. **Make indentation explicit in `read_file` output** (small). Fixed-width line numbers and a
   non-space separator, e.g. `365│    def user_prompt`, so the prefix cannot blend into the
   indentation. Optionally add the indent width the way the model ended up doing itself
   (`365|4|def user_prompt`). Also state once in the observation header that whitespace after the
   separator is exact. (Finding 1)

3. **Truncate over-long fact and hypothesis values instead of rejecting** (small). Cut to the
   limit, append "…", and put a one-line notice in the next observation ("facts.X was truncated to
   300 chars; split it if the tail mattered"). Keep the 12 KB total as the hard bound. Where a
   rejection is kept, include the actual length in the message. Removes 15 of 25 rejections and
   both run deaths. (Findings 2, 6)

4. **Distinguish soft and hard rejections in the retry budget** (small). Count only malformed
   replies and phase violations toward `MAX_RETRIES`; after the third failure, checkpoint with
   the last valid attempt's state patch applied rather than discarding it. Alternatively raise the
   budget to 4 only when the previous attempt was valid apart from a bound. (Finding 6)

5. **Accept unfenced or unclosed JSON** (small). In `lastFencedJson`, when no closed fence is
   found, take the text from the last ```` ```json ```` opener to the end, and failing that the last
   balanced `{…}` object in the reply. Reject prose-only replies with a message that says the
   block was missing, not "Unexpected token 'S'". Saves 2 of 6 parse rejections and makes the
   other 4 cheaper to understand. (Finding 5)

6. **Record only real checks in `checks`, and detect masked failures** (small). Treat an
   `exec_shell` as a check only when the command matches the existing `COMMAND_TOKEN` test-runner
   list; everything else is a read. Run commands with `bash -o pipefail -c` when bash exists, and
   scan output for `N failures`, `FAILED`, `error` counts to override a 0 exit code in the summary.
   (Findings 3, 8)

7. **Record hidden reasoning tokens** (small). Add `visibleChars` (already have
   `reasoningChars` plus reply length) and, if Pi's usage object exposes it, a reasoning-token
   count to `StepTelemetry`; print the billed-to-visible ratio in the runlog table. Then decide
   per model whether thinking should be requested off, or at a low effort, via the provider
   options. Until then correct the README sentence. (Finding 4)

8. **Mark resume boundaries in the runlog tool** (small). Print a `── resumed at step N (HH:MM)
   ──` row in the table and in `--rejections`, and show the elapsed gap. (Finding 7)

9. **Strip wrapping quotes from the objective** in `parseArgs`. (Finding 9)

10. **Do not add search hits to `inspectedFiles`** (small). Keep a separate `matchedFiles` list or
    just leave search results in the observation. (Finding 9)

11. **Measure whether extension tools earn their prompt bytes** (medium). Two runs of the same
    objective with `--no-tools` and without; if the model never picks one, drop the vocabulary
    from the prompt by default and add tools only via a flag. (Finding 9)

12. **Reconsider the `exec_shell` read path** (medium). Once 1 and 2 land, check whether shell
    reads drop. If they do not, route `sed -n`/`cat`/`head`/`tail` of a single file through
    `readFileWindow` so they get the same numbering, duplicate-read note and `inspectedFiles`
    bookkeeping. (Finding 3)

## What this data cannot tell you

- Whether items 1 and 2 fix the indentation loss or only the recovery cost. The model claimed
  even `cat -A` output lost whitespace, which points at how it reads runs of spaces, not at
  `read_file`. A whitespace-tolerant patch sidesteps the question.
- Anything about the test phase: the first `rspec` ran at step 51 into a missing Postgres, so
  `testing` and `repairing` behaviour on a real failure is still unobserved on this repo.
- Whether `glm-5-3`'s hidden reasoning helps. There is no run of this objective on a model without
  it to compare against.
- Whether the resulting code is right. `git diff` in glyph shows the interpolation landed in
  `pi_agent_runner.rb` and a spec was added; nothing has passed yet.

## How to get better data next time

- Run the same objective again after items 1 to 3 and compare: failed patches, rejected
  attempts, `exec_shell` reads, steps to first test.
- Start Postgres (or point `DATABASE_URL` at a running instance) before a run whose plan ends in
  `rspec`, otherwise the testing phase is unobservable.
- `bun extensions/skill-state/tools/runlog.ts sr-mtpp8znz --cwd ~/Workspace/glyph --step 10`
  shows the failing patch and the read that preceded it side by side.
