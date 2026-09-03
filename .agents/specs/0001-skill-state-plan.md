# Implementation Plan: SKILL.state Extension (`/state-run`)

Reviewed against arXiv:2608.26263v2 (*SKILL.state: Scalable Long-Horizon Agent Skills*, Badhe et al., Aug 2026) and against the installed Pi API (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 0.84.x). Section 2 records what the paper actually claims and which of those claims this extension can and cannot reproduce. Sections 3+ are the corrected plan.

---

## 1. Overview & Goals

A Pi extension that executes long-horizon software-engineering objectives with the SKILL.state runtime instead of Pi's append-only conversation:

$$A_t = (P,\ \Sigma_t,\ O_t) \;\longrightarrow\; (R_t,\ \Delta\Sigma_t,\ a_t), \qquad \Sigma_{t+1} = \Sigma_t \oplus \Delta\Sigma_t$$

- $P$: frozen skill specification (built-in SE workflow or a markdown file).
- $\Sigma_t$: small, schema-validated JSON execution state owned by the runtime.
- $O_t$: only the latest, bounded observation.
- $R_t$: within-step chain-of-thought, discarded after the step.
- $\oplus$: dictionary merge with null-deletion.

The model never sees previous observations, previous actions, or previous reasoning.

### Goals (in priority order)
1. **Faithful runtime**: implement Algorithm 1 of the paper exactly (prompt shape, output contract, merge operator, rollback-retry on invalid patch).
2. **Measurable bounds**: prove locally that per-step prompt size is flat and cumulative tokens are linear in step count.
3. **Usable SE agent**: bounded repository-local action vocabulary, safe execution, non-intrusive persistence in the Pi session.

### Non-goals
- Reproducing the paper's accuracy numbers (see §2.2). No benchmark harness, no baseline runtimes.
- Multi-agent shared state, grammar-constrained decoding (paper §7, future work).

---

## 2. Paper Analysis: What We Will and Will Not Achieve

### 2.1 What the paper measures

| Claim | Evidence in paper | Reproducible here? |
| --- | --- | --- |
| $O(1)$ prompt per step, independent of $t$ | §3.3; Table 1 avg prompt 1,736–1,905 tokens for $T$ = 10…200 | **Yes, by construction**, if spec, state, and observation are each byte-capped (§5.4). We verify it with per-step telemetry. |
| $O(T)$ cumulative tokens (16× fewer than history baselines at $T$=100) | Table 1, Table 6 | **Yes for the linear shape.** The multiplier vs. plain Pi depends on our observation cap; with 50 KB observations the constant is ~6× the paper's whole prompt, and the saving mostly disappears. Caps lowered in §5.4. |
| Accuracy ≥ ReAct / Summary / LangGraph baselines | Tables 1–8; Warehouse and Software-Repo simulators, InterCode CTF, τ-Bench; Gemini-3-Flash, 5 seeds, temperature 0 | **No.** Requires a deterministic scored environment plus three baseline runtimes under the same harness. Out of scope for a Pi extension. We report success/failure and step counts, we do not claim accuracy parity. |
| Noise robustness (Table 2) and zero-step state recovery (Table 3) | Injected telemetry; external state drift | **Partially, qualitatively.** The mechanism (distractors never re-enter the prompt) is inherited. No controlled measurement. |
| Budget-matched controls (Table 5): structured state beats truncation/summary/LLMLingua at equal budget | §5.6 | **Not measured.** Noted so nobody reads our token numbers as proof of this. |

### 2.2 Where the paper itself says this domain is hard

Paper §7 (Limitations) names three failure conditions. Real-repo software engineering hits **condition (2)** directly: "a correct state update depends on an earlier observation whose relevance was not recognized when first observed". A file read at step 3 is gone by step 4; if step 12 needs it, the model must re-read it. The paper's own benchmarks (shelves, CTF flags, database rows) have a natural sufficient statistic; source code does not. Consequences we must design for:

- Expect **more steps** than a ReAct agent on the same task (re-reads). Track `reReadCount` in telemetry so this is visible, not hidden.
- The state must give the model room to write down *why* a file matters (`facts`), otherwise it re-reads everything.
- The spec must instruct the model to record salient facts *before* moving on, since that projection is the whole mechanism.

The original plan did not mention this limitation at all. It is the main reason results on this extension will look weaker than Table 6.

### 2.3 Divergences between the original plan and the paper (fixed below)

| # | Original plan | Paper | Fix |
| --- | --- | --- | --- |
| 1 | Model output is JSON-only `{ state_patch, action }` | Appendix A.4: model emits **step-by-step reasoning first**, then one fenced ```json block; §3.2 calls intact within-step CoT "crucial" | Adopt the paper's output format. Parse the **last** fenced JSON block; discard everything before it. |
| 2 | No mention of decoding settings | Temperature 0, top-p 1 | Pass `temperature: 0` in the `complete` options. |
| 3 | Observation cap 2,000 lines / 50 KB | Prompt ~1.8–2.8k tokens *total* | Cap observation at 200 lines / 8 KB (head+tail). |
| 4 | State cap 16 KB, 14 fields, model writes `inspectedFiles` | Schemas are 5-ish fields per domain; paper §5.7: 68 % of small-model errors are **premature overwrite** of existing keys | Trim schema, make `inspectedFiles` runtime-owned, state cap 6 KB, and spell out merge semantics in the prompt. |
| 5 | Retry on invalid output "with targeted error diagnostics" (unspecified shape) | §7: invalid patch triggers **rollback-retry**; state untouched | Retry is a *fresh* $(P, \Sigma_t, O_t + \text{validation errors})$ prompt, never a multi-turn transcript. |
| 6 | Array fields "deduplicated, capped" with implicit semantics | $\oplus$ is key-level mutation with null-delete | Objects merge shallowly with null-delete; arrays are **replaced whole** by the patch. Stated in the prompt. |

### 2.4 API errors in the original plan (verified against installed types)

| Assumption | Reality | Fix |
| --- | --- | --- |
| `complete(ctx.model, ctx, { signal: ctx.signal })` authenticates itself | `complete()` from `@earendil-works/pi-ai/compat` takes `apiKey`, `headers`, `env` in options; nothing resolves them for you | Call `ctx.modelRegistry.getApiKeyAndHeaders(model)` once per run; fail fast if `ok` is false; spread `baseUrl` onto a model copy when present. |
| `ctx.signal` cancels the run | `ExtensionContext.signal` is "undefined when the agent is not streaming". A command handler is not streaming. | Runner owns an `AbortController`. Add `/state-cancel`. Abort on `session_shutdown`. |
| `execCommand` imported from `@earendil-works/pi-coding-agent` | Only the `ExecOptions` type is exported from the package index | Use `node:child_process` `spawn` with `AbortSignal` and a timeout. |
| Truncation "using standard truncation logic" | `truncateHead`, `truncateTail`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES` **are** exported | Use them with our own smaller limits. |
| `pi.appendEntry` entries stay out of LLM context | Confirmed: "Append a custom entry to the session for state persistence (not sent to LLM)" | Keep. |

**Verdict**: the original plan reproduces the architecture in spirit but (a) would not compile against Pi as written, (b) drops the paper's reasoning-then-JSON contract, (c) sets bounds that erase the token advantage, and (d) silently promises accuracy results it has no way to measure. The corrected plan below fixes (a)–(c) and makes (d) explicit.

---

## 3. Architecture & System Flow

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Pi Session (outer loop, untouched)                                       │
│   /state-run [--skill <path>] [--max-steps N] <objective>                │
│   /state-cancel                                                          │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ command handler awaits runner; UI stays responsive
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ runner.ts                                                                │
│  0. resolve model + auth (ctx.model, ctx.modelRegistry)                  │
│  1. P  := loadSpec()            (frozen for the run)                     │
│  2. Σ0 := createInitialState(objective)                                  │
│  3. O0 := workspace snapshot (cwd, git status --short, top-level ls)     │
│                                                                          │
│  loop while status ∉ {completed, failed, cancelled} and step < max:      │
│    prompt := render(P, Σt, Ot)                 ── O(1) bytes, see §5.5   │
│    reply  := complete(model, prompt, {apiKey, headers, temperature: 0})  │
│    parsed := lastFencedJson(reply.text)  → validate (TypeBox)            │
│      invalid → retry same (P, Σt, Ot) + error list, ≤ 2 times            │
│      still invalid → status = failed                                     │
│    Σt+1 := merge(Σt, state_patch)           ── null deletes, arrays swap │
│    Ot+1 := execute(action)                  ── bounded, repo-local       │
│    runtime fields: step, inspectedFiles, changedFiles, checks            │
│    appendEntry("skill-state-step", telemetry)                            │
│    ui.setStatus("state-run", `step ${t} ${status} ${action.type}`)       │
│                                                                          │
│  finish: appendEntry("skill-state-run", summary); ui.notify(...)         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. File Structure

```text
extensions/skill-state/
├── index.ts      # register /state-run, /state-cancel, entry renderers
├── schemas.ts    # TypeBox: State, StatePatch, RepoAction, StepResponse
├── state.ts      # createInitialState, merge (⊕), bounds enforcement
├── prompt.ts     # render(P, Σ, O) exactly per paper Appendix A.4; lastFencedJson
├── executor.ts   # repo-local actions via node:fs / node:child_process; observation bounding
├── workflow.ts   # built-in SE spec; --skill markdown loader
├── runner.ts     # loop, auth, complete(), retry, telemetry, cancellation
└── README.md
```

Matches repo conventions: default-exported factory in `index.ts`, imports only from Pi's dependency tree (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai/compat`, `typebox`) and Node built-ins, no build step.

---

## 5. Specification

### 5.1 State schema (`schemas.ts`)

Small on purpose. Paper §3.1 uses a 5-field schema for all 100 CTF tasks.

```typescript
export interface SkillExecutionState {
  // runtime-owned (model patches to these are a validation error)
  version: 1;
  step: number;
  objective: string;
  inspectedFiles: string[];   // appended by executor on read_file / search_files hits
  changedFiles: string[];     // appended by executor on write_file / patch_file
  checks: Array<{ command: string; code: number; summary: string }>; // last ≤ 5 exec_shell results

  // model-owned
  status: "inspecting" | "planning" | "editing" | "testing" | "repairing";
  plan: string[];                     // ordered remaining steps, replaced whole
  hypotheses: Record<string, "open" | "confirmed" | "rejected">;
  facts: Record<string, string>;      // the projection of past observations; null deletes
  blockers: string[];
}

export interface StatePatch {
  status?: SkillExecutionState["status"];
  plan?: string[];
  hypotheses?: Record<string, "open" | "confirmed" | "rejected" | null>;
  facts?: Record<string, string | null>;
  blockers?: string[];
}

export type RepoAction =
  | { type: "search_files"; pattern: string; glob?: string }
  | { type: "read_file"; path: string; offset?: number; limit?: number }
  | { type: "write_file"; path: string; content: string }
  | { type: "patch_file"; path: string; oldText: string; newText: string }
  | { type: "exec_shell"; command: string; timeoutMs?: number }
  | { type: "git_diff"; paths?: string[] }
  | { type: "finish"; outcome: "completed" | "cannot_complete"; summary: string };

export interface StepResponse { state_patch: StatePatch; action: RepoAction; }
```

TypeBox schemas use `additionalProperties: false` so an attempt to patch `step`, `changedFiles`, etc. surfaces as a named error path.

### 5.2 Merge operator $\oplus$ and bounds (`state.ts`)

- `facts`, `hypotheses`: shallow merge; a `null` value deletes the key.
- `plan`, `blockers`: replaced whole by the patch value.
- `status`: replaced.
- Bounds, enforced **after** merge, failing the patch (rollback) if exceeded:
  - `facts`: ≤ 24 keys, key ≤ 64 chars, value ≤ 300 chars.
  - `hypotheses`: ≤ 12 keys. `plan`, `blockers`: ≤ 15 items.
  - Serialized $\Sigma$ ≤ 6 KB.
  - `checks` keeps only the last 5; `inspectedFiles`/`changedFiles` deduplicated, ≤ 40 entries (oldest dropped).
- A patch is applied atomically: validate → clone → merge → bound-check → commit. On any failure $\Sigma_t$ is unchanged (paper §7 rollback).

### 5.3 Prompt (`prompt.ts`), verbatim shape of paper Appendix A.4

System prompt: none (single user message, as in the paper). User message:

```text
Instructions:
{spec}

Repository action vocabulary (JSON, exactly one per step):
{compact list of RepoAction shapes with one-line semantics}

State update rules:
- "state_patch" is merged into the state. Only include keys you change.
- Object fields (facts, hypotheses): keys merge; set a key to null to delete it.
- List fields (plan, blockers): the list you send replaces the old list entirely.
- Never send: version, step, objective, inspectedFiles, changedFiles, checks.
- Before leaving a file, write what you learned into facts. You will not see this observation again.

Skill Execution State:
```json
{JSON.stringify(state)}          ← compact, no whitespace
```

Latest Observation:
{observation}

Provide your response with:
1. Step-by-step reasoning (will be discarded after execution)
2. A JSON block fenced with ```json containing both your State Patch and your Action.
   The JSON block MUST have exactly these two keys:
   { "state_patch": { ... }, "action": { ... } }
```

Retry prompt: identical, with an extra section `Previous response was rejected:` followed by the TypeBox error paths and messages. It is still one message with no transcript.

`lastFencedJson(text)`: take the last ```json … ``` block; if none, try the whole text as JSON; else validation error `no_json_block`.

### 5.4 Executor and observation bounds (`executor.ts`)

- All paths resolve under `ctx.cwd`; `path.relative` starting with `..` or absolute paths outside cwd are rejected with an error observation (not a thrown exception).
- `exec_shell`: `spawn("sh", ["-c", command], { cwd, signal })`, default timeout 30 s, max 120 s. Kill on abort.
- Observation = `Result of <action.type>:` header + body. Body bounded with `truncateHead`/`truncateTail`: **≤ 200 lines and ≤ 8 KB**, head 70 % / tail 30 % for command output, head-only for file reads. Truncation notice tells the model how to page (`offset`/`limit`).
- `read_file` records the path in `inspectedFiles`; a repeat read of an already-inspected path increments `reReadCount` in telemetry (paper §7 condition 2 indicator).
- `write_file`/`patch_file` record `changedFiles`; `patch_file` requires exactly one match of `oldText`.
- `exec_shell` appends `{ command, code, summary }` to `checks`.

### 5.5 Model call and per-step budget (`runner.ts`)

```typescript
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok) throw new Error(auth.error);
const target = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
const reply = await complete(target,
  { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
  { apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
    signal: controller.signal, temperature: 0 });   // no `reasoning` key: provider thinking stays off
```

Byte budget per step (all hard caps): spec ≤ 4 KB, state ≤ 6 KB, observation ≤ 8 KB, rules ≈ 1.5 KB → **≤ ~20 KB ≈ 5k tokens**. The paper's SE simulator ran at ~2.5k; ours is larger because real observations are code. It is still independent of $t$, which is the property under test.

Telemetry per step from `reply.usage`: `input`, `output`, `cacheRead`, plus `promptBytes`, `stateBytes`, `observationBytes`, `retries`, `reReadCount`, `durationMs`.

Termination: `finish` action, `--max-steps` (default 40), 2 failed retries on one step, abort. Status → `completed | failed | cancelled`.

### 5.6 Persistence and UI (`index.ts`)

- `pi.appendEntry("skill-state-step", telemetry)` every step; `pi.appendEntry("skill-state-run", { runId, objective, status, steps, totals, avgPromptTokens, maxPromptTokens, reReadCount, changedFiles })` at the end. Both are custom entries, excluded from LLM context.
- `registerEntryRenderer` for both types: one line per step, a small table for the run summary.
- `ctx.ui.setStatus("state-run", ...)` during the run, cleared at the end; `ctx.ui.notify` on finish with outcome and token totals.
- On finish, one bounded (≤ 1 KB) result message is sent into the outer conversation with `pi.sendMessage(..., { triggerTurn: false, deliverAs: "nextTurn" })` (rationale in §8).
- `/state-cancel` aborts the active controller. Only one run at a time; a second `/state-run` while active is refused with a notice.
- Session `session_shutdown` event aborts an active run.

### 5.7 Built-in spec (`workflow.ts`)

≤ 4 KB. Phases `inspecting → planning → editing → testing → repairing → finish` with two rules the paper's mechanism depends on: (1) record salient facts before moving on, (2) prefer `facts` over re-reading. `--skill <path>` loads a markdown file (≤ 4 KB, else error) and uses it as `{spec}` verbatim.

---

## 6. Implementation Tasks

Each task ends with `bun run check` passing. There is no test runner in this repo; behavioural checks are small `bun` scripts under the scratchpad, not committed, unless the user asks for a test suite.

1. **schemas.ts** → verify: a patch touching `step` or with an unknown action type yields a TypeBox error whose path names the field.
2. **state.ts** → verify: null deletes a fact; list patch replaces; an over-cap patch leaves the state byte-identical (rollback).
3. **prompt.ts** → verify: rendered prompt for a fixed $(P,\Sigma,O)$ is byte-stable and `lastFencedJson` picks the final block when reasoning text contains an earlier code fence.
4. **executor.ts** → verify: `../x` rejected; `patch_file` refuses 0 or 2 matches; `exec_shell` of `sleep 5` with `timeoutMs: 100` returns a timeout observation; observation for a 5,000-line file is ≤ 200 lines / 8 KB.
5. **workflow.ts** → verify: built-in spec ≤ 4 KB; oversized `--skill` file rejected.
6. **runner.ts** → verify: with a stub `complete` returning canned replies, a 30-step loop produces telemetry with `promptBytes` variance driven only by observation/state size (never by step index); an invalid reply is retried with the same $\Sigma_t$; abort ends the loop with `cancelled`.
7. **index.ts + README.md** → verify: `/state-run` and `/state-cancel` appear in Pi, entries render, status line clears, a second `/state-run` during a run is refused.

---

## 7. Verification Gates

1. **Type gate**: `bun run check` clean.
2. **Contract gate**: Task 1–2 checks above.
3. **Isolation gate** (paper Eq. 6): log `promptBytes` for a real 20+ step run; assert `max/min ≤ 1.5` and no monotone trend with step index. Assert the prompt contains no substring of any observation other than the latest.
4. **Linear-cost gate** (paper Eq. 7): plot cumulative `input` tokens vs. step; least-squares fit is linear with $R^2 > 0.98$. Compare with a plain Pi session on the same objective by reading the session's cumulative token usage; report the ratio, do not promise the paper's 16×.
5. **Session hygiene gate**: after a run, the outer Pi conversation's context usage (`ctx.getContextUsage()`) grows only by the user's slash command plus the single ≤ 1 KB result message, regardless of how many steps the run took.
6. **Honesty gate**: README states which paper results this reproduces (bounded prompt, linear tokens, mechanism) and which it does not (benchmark accuracy, noise/recovery tables, budget-matched controls), and cites paper §7 condition 2 as the expected weak spot on real code.

---

## 8. Decisions

**Reasoning: textual $R_t$ in the reply, provider thinking off.**
The paper's contribution is architecture-agnostic (§1, §6): the same runtime and the same prompt ran on Gemini-3-Flash, Gemma-4-31B, and Qwen-3-8B. Textual reasoning in the response is the only mechanism that works identically on every model Pi can select, and it is what Appendix A.4 specifies. Native thinking would add a second, hidden reasoning pass whose tokens count toward the paper's "Total Tokens" metric without being visible in telemetry. Therefore `complete(...)` is called without a `reasoning` option (`ThinkingLevel` has no "off" value; omitting it disables provider thinking) rather than with `ctx.thinkingLevel`, and the rules section keeps "Step-by-step reasoning (will be discarded after execution)". Both the textual $R_t$ and any provider thinking are dropped after the step either way, so isolation is unaffected.

**Finish summary: one bounded message into the outer conversation, no turn triggered.**
The paper's argument is that the information needed for future decisions should be projected into explicit state rather than reconstructed later from history (§1, §3.2). After a run, the outer Pi agent's next decision needs exactly that projection: outcome, what changed, what is left. Withholding it forces the outer agent to re-derive the result by re-reading the repository, which is the reconstruction the paper argues against. Injecting the full run transcript would be history accumulation. The middle ground is $O(1)$ per run:

- `pi.sendMessage({ customType: "skill-state-result", content, display: true }, { triggerTurn: false, deliverAs: "nextTurn" })`.
- `content` ≤ 1 KB: objective, final status, `finish.summary`, `changedFiles`, last `checks`, step count, total tokens. Hard-truncated.
- No LLM call is made at that moment; the message enters context only when the user speaks next.

Telemetry (per-step and run summary) stays in `appendEntry` custom entries, outside LLM context, as in §5.6.
