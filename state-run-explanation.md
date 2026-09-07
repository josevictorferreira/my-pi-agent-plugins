# `/state-run` vs a normal Pi prompt: what changes under the hood

You type an objective either way. What differs is *what the model is allowed to remember* and *who is in charge of the loop*.

## The one-sentence version

A normal Pi prompt is a **conversation that grows**: every tool call and result is appended to the transcript, and the whole transcript is sent to the model again on every turn. `/state-run` is a **loop with amnesia**: each step the model sees only a fixed spec, a small JSON "state" it maintains itself, and the result of its last action. Nothing else. The runtime, not the model, decides when a reply is acceptable.

## Side by side

| | Normal Pi prompt | `/state-run` |
| --- | --- | --- |
| What the model sees each call | System prompt + the **entire** conversation so far (all tool calls, all tool outputs, all reasoning) | Spec (≤ 4 KB) + JSON state (≤ 12 KB) + **only the latest** observation (≤ 8 KB / 200 lines) |
| Memory | The transcript. Free, automatic, unbounded | A JSON object the model must explicitly write to (`facts`, `hypotheses`, `plan`, `blockers`). If it didn't write it down, it's gone |
| Prompt size over time | Grows every turn. Cumulative tokens grow quadratically | Flat. Cumulative tokens grow linearly with steps |
| How tools are called | Native provider tool-calling (function calling); Pi's built-in tools plus extension tools | One JSON action per step, in a fenced ```` ```json ```` block, parsed by the extension. Its own small vocabulary: `search_files`, `read_file`, `write_file`, `patch_file`, `exec_shell`, `git_diff`, `tool`, `finish` |
| Who runs the loop | Pi's agent loop | `runner.ts` in the extension. It calls the model directly through `pi-ai`'s `complete()`, bypassing Pi's conversation entirely |
| Validation of the model's reply | None beyond what the provider enforces | Strict: JSON schema, state bounds, and **phase rules**. A bad reply is rejected and the same prompt is re-sent with the errors attached; state is untouched |
| Reasoning | Stays in the transcript, re-sent forever | Discarded after the JSON is parsed. Only visible in the TUI step entry and the run log |
| Effect on your chat | Everything lands in the conversation | Nothing, until the run ends. Then one ≤ 1 KB result message is queued for your next turn |
| Recovery | Resume the session | Checkpoint file with the state. `/state-resume` continues from it with **any** model |

## What actually happens on each step of `/state-run`

This is Algorithm 1 from the SKILL.state paper, implemented in `runner.ts`:

1. **Render the prompt** (`prompt.ts`). The system prompt is the frozen spec + action vocabulary + state rules. It is byte-identical every step, so the provider's prompt cache can serve it. The user message is the current state as JSON, the latest observation, and the step counter ("step 12 of at most 250").
2. **Call the model** (`index.ts`, `makeComplete`). A single `complete()` call with a one-message conversation. No history. If the provider fails, retry up to 4 times with backoff.
3. **Parse the reply**. Take the last fenced JSON block. It must have exactly two keys: `state_patch` and `action`. Everything before the block is reasoning and is thrown away.
4. **Validate**. Schema check (`schemas.ts`), then merge the patch into the state (`state.ts`) and check bounds (40 facts, 12 hypotheses, 15 plan items, 12 KB total). Then check the phase policy (see below). If anything fails, go back to step 1 with the errors appended. Hard errors (malformed JSON) get 3 tries, soft ones (bounds, phase) get 5. Exceeding either kills the run and checkpoints it.
5. **Commit the state**. `Σt+1 = Σt ⊕ ΔΣt`. Maps merge by key with `null` meaning delete; lists are replaced whole.
6. **Execute the action** (`executor.ts`). Runs in the repo root with path escaping blocked. The output is bounded and becomes the *only* observation for the next step.
7. **Update runtime-owned fields**. `inspectedFiles`, `changedFiles`, `checks`, `readsSinceWrite`, `lastWriteStep`. The model sees these but cannot write them.
8. **Log and render**. Append to the JSONL run log, emit a TUI entry, update the live panel. Loop.

## The phase machine the runtime enforces

The state has a `status` field the model owns: `inspecting → planning → editing → testing → repairing`. In a normal prompt, you'd ask the model to follow phases and hope. Here the runtime *rejects* replies that break them:

- `inspecting` must end within a third of the budget (max 30 steps).
- `planning` lasts at most 2 steps and needs a non-empty plan where every item names a file or a command.
- In `editing`, after 3 actions that changed no file, the next action **must** be a write or `finish`.
- `editing` and `repairing` end after 12 steps with no file change.
- `testing` requires at least one changed file.
- A byte-identical write that already failed against an unchanged file is refused before it runs.
- An identical read that already ran gets a note prepended: "you already did this, write facts instead."

These exist because the models tested ignored prose rules but obeyed validation errors on the first retry, every time.

## Why anyone would want this

**Cost.** In a normal prompt, a 200-step task re-sends a growing transcript 200 times. Here every step costs roughly the same, and the 4 KB system half is cache-hit.

**Bounded context.** The model can never run out of context window, no matter how many steps. Long-horizon tasks don't degrade as the transcript fills with stale tool output.

**Recovery and model swap.** The state file *is* the run. You can stop, switch models with `/model`, and `/state-resume`. A normal session is tied to its transcript.

**Observability.** Every prompt, reply, rejection, state and observation is in a JSONL log per run. `bun extensions/skill-state/tools/runlog.ts <runId>` shows exactly what the model saw and said at any step.

## What you give up

**Working memory is manual.** In a normal prompt the model remembers a file it read 30 turns ago. Here, if it didn't write the relevant lines into `facts` before moving on, it has to re-read the file. The README calls this the expected weak spot: expect *more steps* than a normal agent, with the saving being tokens per step, not step count.

**Exact text is fragile.** `patch_file` needs a unique `oldText`. A fact cut at 600 chars is marked `[CUT]` and is no longer exact. The model is told to re-read only to get exact text for a patch.

**No native tool calling.** Actions are hand-written JSON in a text reply. The parser is forgiving (unclosed fences, bare objects) but a reply with no JSON is a rejected attempt.

**Smaller toolbox.** Only the repo-local actions above, plus read-only extension tools if you pass `--tools` (codegraph, context7, lsp, web tools, hindsight recall). Writing tools are deliberately excluded so change tracking and the phase policy keep working.

**One run at a time**, and the run does not talk back mid-way. It ends with `finish`, a failure, cancellation, or the step cap. If it hits a blocker, you answer it by resuming with a note: `/state-resume --max-steps 60 <your note>`.

## Where things live

| What | Path |
| --- | --- |
| Per-run trace (every prompt, reply, state, observation) | `~/.pi/agent/skill-state/<cwd-slug>/logs/<runId>.jsonl` |
| Checkpoints of failed or cancelled runs | `~/.pi/agent/skill-state/<cwd-slug>/<runId>.json` |
| Step and run entries (TUI only, never sent to the model) | the Pi session file |

## Mental model to keep

Normal prompt: **"Here is everything that happened. What next?"**

`/state-run`: **"Here is the rulebook, here is your notebook, here is what you just saw. Update the notebook and pick one move."** The runtime is a strict referee that only accepts legal moves.
