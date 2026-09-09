# skill-state: findings from run `sr-mtpvz4v6` and proposed improvements

Date: 2026-09-06. Source: the only run log on this machine,
`~/.pi/agent/skill-state/-home-josevictor-Workspace-glyph/logs/sr-mtpvz4v6.jsonl`
(7.3 MB, 721 events), plus the checkpoint next to it. The log analysed in
`improvements_2.md` (`sr-mtpp8znz`) is gone from disk, so this is a different run and
nothing here is a re-read of the same data.

Model `velox/glm-5-3`, cwd `~/Workspace/glyph`, extension tools on, `--reasoning` not set.
Objective: *"Add a 'create new helper' option in the options when we right click in a empty
place on canvas"*. The run was still live when this was written; the snapshot is step 346.

| Segment | Steps | Clock (UTC) | Budget | Ended by |
| --- | --- | --- | --- | --- |
| Run 1 | 1–250 | 14:07:39 → 15:43:48 (96 min) | 250 | budget exhausted, `failed` / `cannot_complete` |
| Resume 1 (no note) | 251–346 | 16:02:08 → 16:53:01 (51 min, ongoing) | 500 | still looping at snapshot time |

Headline: **3 successful writes in 346 steps.** 161 `patch_file` attempts, 158 of them
rejected with the same error on the same file. 88% of all steps (303/346) were spent in
`editing`, and the last file actually changed was at step 208 — 138 steps of zero progress
and counting.

Cost of that: 927,489 input tokens, 533,807 output, `cacheRead` 0 across all 372 attempts;
147 minutes of wall time, essentially all of it model latency (8,818,663 ms summed over
attempts).

## Findings

### 1. `patch_file` matching is tolerant of leading whitespace but not of interior whitespace, and that cost 158 steps

`applyPatch` (`executor.ts:324`) falls back to comparing `line.trim()` against `line.trim()`.
That fixes indentation — the fix shipped from `improvements_2.md` item 1 — and it worked
twice in this run (steps 25 and 83 both report *"Your oldText was indented N chars, the file
M; newText was re-indented"*).

It does not help when the model loses whitespace *inside* the line. The target is:

```
36│  action :add_step_at_canvas_position, params: { step_canvas_x: :integer, step_canvas_y: :integer }
37│  action :add_helper_step
```

and every one of the 158 failures sent some variant of:

```
action:add_step_at_canvas_position, params: { step_canvas_x::integer, step_canvas_y::integer }
action:add_helper_step
```

The space after `action` and the space between `step_canvas_x:` and `:integer` are gone.
`trim()` cannot see past that, so the anchor line never matches and the error is always the
same sentence: *"no line of the file equals its first line … (compared without indentation).
read_file the region and copy the text exactly."*

I replayed all 158 failing `oldText` values against the file as it stood during the loop
(current file minus the one line added at 16:57):

| Matching rule | Failures it resolves |
| --- | --- |
| current: exact, then `trim()`-per-line | 0 of 158 |
| + compare with **all** whitespace collapsed | 118 of 158, all unique, none ambiguous |
| + allow the **last** `oldText` line to be a prefix of its file line | the remaining 40 |

Together: **158 of 158, zero ambiguous matches.** This one change turns the whole run around.
It is also low-risk here — uniqueness is still required, so an ambiguous normalised match
falls through to the existing "matches at lines A, B; include more context" error.

### 2. The good error message is unreachable exactly when it is needed

`executor.ts:381` has the message this run needed — *"its first line is at line N but the
following lines differ. The file there reads: …"* with the exact numbered text. It fired zero
times. It is gated on `fileLines.findIndex(l => l.trim() === anchor)` succeeding, i.e. on the
first line matching under the same rule that already failed. When the model mangles interior
whitespace, the anchor lookup fails too, and the model gets the useless one-liner instead.

The anchor lookup should use the loosest comparison available (whitespace-collapsed, then a
similarity score) precisely because it is only used to *locate* text for an error message —
a wrong guess costs nothing, a missing guess costs 158 steps.

### 3. A failed write resets the read-streak counter, disabling the only loop guard

`recordAction` (`state.ts:181`) is called from `runner.ts:330` with `action.type` and never
looks at the result:

```ts
if (WRITE_ACTIONS.has(actionType)) state.readsSinceWrite = 0;
```

So a `patch_file` that threw counts as a write. The `READS_BEFORE_EDIT = 3` policy
(`state.ts:172`) is the runtime's only defence against read-loops, and the alternating
pattern `read_file → failed patch_file → read_file → failed patch_file` resets it every
other step. It fired **once** in 346 steps.

Fix: pass the execution result into `recordAction` and reset `readsSinceWrite` only when
`result.changed` is set. Failed writes should count as reads.

### 4. Nothing caps `editing`, `testing` or `repairing`

`phaseErrors` (`state.ts:117`) budgets `inspecting` (≤ 30 steps) and `planning` (≤ 2 steps).
`editing` has no ceiling, which is how 303 of 346 steps landed there and how the run spent
138 consecutive steps in a phase that produced nothing.

The state already carries `statusSince` and `changedFiles`. A rule of the form "in `editing`
for more than N steps with no growth in `changedFiles`" is cheap and would have ended this at
around step 230. What it should do is arguable — force `status` to `repairing` or `testing`,
or require `finish` — but silently allowing 138 no-op steps is not.

### 5. Identical failing actions are never detected

`runner.ts:331-345` keeps `seenReads` for `read_file` and `search_files` and prefixes a repeat
with *"this exact action already ran at step N"*. Writes are excluded, so:

| Repeats | `oldText` sent (whitespace as sent) |
| --- | --- |
| 30 | `action:add_helper_step\naction:save_step_details` |
| 29 | `action:add_helper_step\naction:save_step_details, params: { step_id::string, …` |
| 27 | `action:add_step_at_canvas_position, params: { step_canvas_x::integer, …` |
| 20 | same as above with one leading space |

22 distinct `oldText` values, 158 attempts. A byte-identical `(path, oldText)` that already
failed is provably going to fail again — the file did not change in between, and the runtime
knows that. Reject it *before* executing, as a hard rejection, with the text of the previous
error and the exact file region.

### 6. The repeat-read note pushes the model toward the thing that poisoned it

89 of the 169 `read_file` steps were exact repeats and got the note:

> Record what you need in facts instead of repeating it.

That advice is right for structural knowledge and wrong for the one case in the spec that
mandates re-reading ("re-read only for exact text to patch"). The model obeyed: it wrote the
exact registry text into `facts` — in its own mangled form — and then patched from the fact
instead of from the observation. At step 344 it had the correct text on screen and still
reasoned *"Line 37 is `action:add_helper_step` with no leading indentation"* before emitting
the corrupted version and claiming it was "copied verbatim from read_file".

The note should not be shown when the previous step was a failed `patch_file` on the same
path, and should say *"copy the text below, do not retype it from facts"* instead.

### 7. Truncating a fact to 300 characters silently corrupts exact text

`mergeMap` (`state.ts:47`) cuts over-long values and reports the cut. That change (from
`improvements_2.md` item 3) worked: zero length rejections and no run death from it, against
14 of 25 rejections previously.

But it fired 31 times across 30 distinct keys, and look at what the model was trying to store:
`registry_exact`, `registry_verbatim`, `registry_lines_exact`, `editor_rb_registry_exact`,
`action_reg_exact`, `registry_L37`, `registry_confirmed`, `registry_verified_304`…

The model was fighting the cap to store one 99-character source line plus context, and each
truncation left behind a fact that is not short but *wrong* — a code fragment cut mid-token,
which then gets patched with. `facts.editor_rb` was cut from 420 chars four separate times.

Two options: raise `MAX_FACT_VALUE_CHARS` (the 12 KB total is the real bound and the state
only reached 4.4 KB here), or make truncation visible in the value itself — append a marker
like ` […cut]` so a truncated fact cannot be mistaken for exact text. Currently `clip` appends
`…`, which reads as prose ellipsis, not as "this is not the whole string".

### 8. Brace globs silently return zero matches

`search_files` passes `glob` straight through as a git pathspec (`executor.ts:172`) or as
`grep --include` (`executor.ts:180`). Neither does brace expansion. Verified in the glyph
repo:

```
git grep -e add_helper_step -- '{app,spec}/**/*'   → 0 matches
git grep -e add_helper_step -- 'app/**'            → 3 matches
```

Both of this run's globbed searches hit it:

- step 1: `*.{rb,js,ts,jsx,tsx,html,erb,haml}}` → "No matches" (also a stray `}` from the model)
- step 231: `{app,spec}/**/*` searching for `add_helper_step_at_canvas_position` → "No matches",
  while `rspec` was simultaneously failing *because that symbol was referenced*

The model diagnosed the runtime itself and wrote a fact about it:

> `search_glob_issue`: "brace-expansion glob unreliable; use plain globs like `*.rb` or none"

A "no matches" that is actually "your glob is unsupported" is the worst possible answer: it is
indistinguishable from ground truth and it sent the model down a wrong branch. Either expand
braces before handing the pattern to git, or detect `{`/`}` in the glob and reject the action
with a message.

### 9. Extension tools cost 1.6 KB per prompt and were used zero times

The `Extension tools` block (codegraph, context7, hindsight, lsp, web_fetch, web_search) is
1,662 bytes of every prompt. Across 372 attempts that is ~618 KB of prompt, and the action
histogram is:

```
169 read_file   161 patch_file   11 exec_shell   4 search_files   1 finish
  0 write_file    0 git_diff       0 tool
```

`improvements_2.md` item 11 asked for two runs to decide this. One run is not proof, but it is
a strong prior for this model, and the `lsp` tool in particular would have answered "where is
`add_helper_step` declared" instantly. Worth making the block opt-in (`--tools`) or at least
naming the two or three tools that map onto the phases, rather than dumping full parameter
schemas.

### 10. Check summaries capture the least informative line

`executor.ts:476` records `lastLine` of the output as the check summary. For rspec that is the
seed line, so `checks` reads:

```json
{"command":"bundle exec rspec …","code":1,"summary":"Randomized with seed 52951"}
```

Both recorded checks say this. The output two lines earlier said `22 examples, 2 failures` and
named `action :add_helper_step_at_canvas_position is not declared`. `checks` is carried in
every subsequent prompt, so this is 2 × ~60 bytes of pure noise where the actual diagnosis
would have fit. Scan the tail for a failure-count line (`N failures`, `N failed`, `FAILED`,
`Tests: … failed`) before falling back to the last line.

### 11. Smaller observations

- **No prompt caching.** `cacheRead` is 0 for all 372 attempts. The spec (2,026 bytes) plus
  action vocabulary (2,303 bytes) are byte-identical on every step — over 4 KB of stable
  prefix per call, ~1.6 M cacheable tokens across the run, all paid at full price.
- **Malformed replies: 23 of 372 attempts (6.2%)**, 21 `no_json_block` and 2 `invalid_json`.
  The `improvements_2.md` item 5 relaxations shipped; this is the residue. It is spread evenly
  (13 in segment 1, 8 in segment 2), so it is a per-call rate, not a degradation.
- **Resume re-enters the loop with no signal.** The resume at 16:02 raised the budget to 500
  and handed the model back the same state, in `editing`, with the same wrong fact. Nothing in
  the prompt says "you resumed" or "the previous segment ended without progress". 96 more steps
  went the same way.
- **`reReadCount` was 118 in segment 1** and appears in the run summary but never in the
  prompt. The model has no visibility into how much of its own budget it is burning on rereads.
- **The runtime asserts "nothing changed since" without checking.** The repeat-read note
  (`runner.ts:338`) clears `seenReads` only on the runtime's own writes. `editor.rb` was
  modified at 16:57 UTC by something outside the run log — the note would have been a lie for
  any read after that. A cheap `mtime` check on the read path would make it honest.
- **`exec_shell` is still the exactness escape hatch.** 7 of the 11 shell commands were
  `sed -n … | cat -A` on the same 3-6 lines. The model does not trust `read_file` output for
  byte-exact work — and in this run it was right not to trust *itself*, but the signal is that
  finding 1's fix matters more than better rendering.

## Improvements, ranked by expected value over cost

1. **Whitespace-insensitive fallback in `applyPatch`** (small; fixes 158 of 158 failures).
   After the `trim()` pass fails, retry with `replace(/\s+/g, "")` per line. Require a unique
   match. Allow the last `oldText` line to be a normalised prefix of its file line (that is 40
   of the 158 on its own). On success, rebuild the replacement from `newText` re-indented to
   the file, and say so: *"matched lines 36-37 ignoring whitespace; your text differed inside
   the line"*. (Finding 1)
2. **Make the near-miss error reachable** (small). Locate the anchor with the loosest
   comparison, not the strictest, so the "the file there reads: …" branch with exact numbered
   text fires whenever any line resembles the anchor. Never emit the bare "no line equals"
   message when a normalised or fuzzy candidate exists. (Finding 2)
3. **Reject a repeat of a failed write before executing it** (small). Track
   `(path, oldText, newText)` for failed `write`s the way `seenReads` tracks reads; on a
   byte-identical repeat, hard-reject with the earlier error plus the exact file region, and
   count it toward `MAX_RETRIES`. Caps this failure mode at ~2 steps per distinct guess
   instead of 30. (Finding 5)
4. **Count failed writes as reads** (one line). Reset `readsSinceWrite` only when the action
   actually changed a file. Restores the read-streak guard, which fired once in 346 steps.
   (Finding 3)
5. **Budget the `editing` phase on progress, not steps** (small). If `state.step -
   state.statusSince` exceeds a threshold and `changedFiles` has not grown since the phase
   began, reject with a message that names the stall and requires `finish`, a status change,
   or a different action type. (Finding 4)
6. **Detect unsupported glob syntax** (small). If the glob contains `{`, either expand the
   braces into multiple pathspecs before calling git, or reject the action with
   *"brace expansion is not supported; pass one glob"*. Never let an unsupported pattern
   return "No matches". (Finding 8)
7. **Do not tell the model to prefer facts when it just failed a patch** (small). Suppress the
   repeat-read note when the previous step was a failed `patch_file` on the same path, and
   replace it with *"the text below is exact; copy it, do not retype from facts"*. (Finding 6)
8. **Make truncated facts unmistakably truncated** (small). Append a visible marker
   (` [CUT]`) rather than `…`, and consider raising `MAX_FACT_VALUE_CHARS` — state peaked at
   4.4 KB of a 12 KB budget while the model burned steps splitting a 99-character source line
   across six keys. (Finding 7)
9. **Pick a real check summary** (small). Scan the last ~20 lines for a failure-count or
   failure-name pattern before falling back to `lastLine`. (Finding 10)
10. **Turn off extension tools by default** (small). 0 uses, 1.6 KB per prompt, 372 prompts.
    Put them behind `--tools` and revisit if a run ever reaches for one. (Finding 9)
11. **Mark the resume in the prompt** (small). One line in the observation on the first step
    after a resume: *"resumed at step N; the previous segment ended in `editing` after K steps
    with no file change"*. The model currently cannot tell it is repeating a dead segment.
    (Finding 11)
12. ~~**Enable prompt caching on the stable prefix**~~ (medium, depends on what Pi exposes). Over
    4 KB of every prompt is byte-identical; `cacheRead` was 0 for the entire run. (Finding 11)
    **Closed as not achievable for these providers** (2026-09-08). The stable prefix was moved
    into the system prompt, where pi-ai puts the provider's cache marker, and `cacheRead` was
    still 0 on all 56 attempts of `sr-mtrd4n6r`. Measured cause: OpenRouter returns no cache
    hits below roughly 9k tokens of prefix, and the prefix here is about 4 KB — roughly 1k
    tokens. Open files enlarge the user half of the prompt, not the cacheable prefix, so this
    does not improve with more context either. Re-open only for a provider that caches short
    prefixes. (improvements_4 §5)

## What this data cannot tell you

- Whether the interior-whitespace loss is specific to `glm-5-3`. It is consistent within this
  run (every one of 22 distinct guesses drops the same spaces around `:`) and matches the
  earlier run's indentation loss, but there is still no run on a second model to compare.
- Whether the objective was achievable. The second rspec failure — `expect(html).to include
  ("Create new helper")` — is a rendering assertion the model never diagnosed, because it
  attributed everything to the missing registry line. Fixing the registry may expose a second
  real bug in `editor_canvas.rb`.
- Anything about `testing` or `repairing` behaviour at depth: rspec ran twice, in 7 steps
  total. Unlike the previous run, Postgres was up and the suite executed — that part is fixed.
- Whether the improvements above interact. Items 3, 4 and 5 all end the same loop; shipping
  all three means no single one gets measured.

## How to get better data next time

- Re-run this exact objective on the same repo after items 1-5 and compare: failed patches
  (158), successful writes (3), steps in `editing` (303), steps to first check (209).
- The replay harness is worth keeping: reconstruct the file as of the loop, pull every failing
  `oldText` out of the log with `jq … .action.oldText | @base64`, and count how many a
  candidate matcher resolves. That is how the 118/40/0 split in finding 1 was produced, and it
  validates a matcher change without a live run.
- `bun extensions/skill-state/tools/runlog.ts sr-mtpvz4v6 --cwd ~/Workspace/glyph --step 344`
  shows the step where the model had the correct text on screen and typed it wrong anyway.
- Keep old logs. `sr-mtpp8znz` from `improvements_2.md` is gone, so none of its rates could be
  re-derived or compared here.
