# Implementation Plan: `hindsight` — user bank + self-learning

## Goal

Split Hindsight memory into two banks — a per-project bank (unchanged) and a
single user-wide bank shared across every project — and make the agent
self-learn: when a run goes wrong because of context the agent did not have,
distill the lesson and store it so it is recallable later.

Everything stays in `extensions/hindsight/index.ts`; no new extension.

**Style anchor:** the existing `extensions/hindsight/index.ts` — `callApi`
helper with `{data|error|status}` return, `deriveBankId` with module cache,
fire-and-forget retention, string concatenation, TypeBox schemas, default-export
factory.

## Decisions (agreed 2026-08-25)

1. Lesson extraction uses the **session's active model** (`ctx.model`), no
   dedicated cheap-model env var.
2. **No double ingestion.** Auto-retention stays project-only (user prompts +
   final response). The user bank is fed only explicitly: the
   `hindsight_retain` tool and the self-learn lesson extractor.
3. **No per-turn recall injection** into the system prompt. The agent decides
   when to call `hindsight_recall`; guidelines nudge it. Consequence: a stored
   lesson only helps if the agent recalls — accepted trade-off, see "Later".

## Research findings

### Hindsight (https://hindsight.vectorize.io)

- **Recall is single-bank.** `POST /v1/default/banks/{bank}/memories/recall`
  takes one `bank_id`; no cross-bank query exists. Two banks → two parallel
  requests merged client-side. Results carry `id, text, type, context,
  metadata, tags, mentioned_at, scores{semantic,keyword,reranker,final}`.
- **Recall filters:** `tags` + `tags_match` (`any` default, `all`, `exact`),
  `types` (`world|experience|observation`), `budget` (`low|mid|high`),
  `max_tokens`.
- **Retain** (`POST .../memories`, body `{items, async}`) item fields:
  `content, context, timestamp, metadata, document_id, tags, entities`.
  `context` and `metadata` are fed to the server-side extraction prompt;
  `tags` are the recall-time filter; `document_id` makes re-ingestion an
  upsert (idempotent).
- **Bank config** (`PATCH /v1/default/banks/{bank}/config`): `retain_mission`
  steers what the extractor keeps; `observations_mission` steers
  consolidation. Banks are auto-created on first retain today; the config
  patch is what needs an explicit call.
- **Observations** auto-consolidate overlapping facts with history ("user
  switched from X to Y") — suits preferences that change over time.
- **Mental models** = saved reflect answers, auto-refreshed
  (`trigger.refresh_after_consolidation`). Would be ideal for a "user profile"
  but they run on **reflect, which times out on the target deployment**
  (README, 2026-08-21). Out of scope until that works.
- Directives / disposition only affect reflect → ignored.

### Pi (https://pi.dev/docs/latest/extensions)

- Events needed all exist: `input` (see the prompt), `agent_end`
  (`event.messages` = whole run), `tool_result` (has `isError`),
  `session_start`.
- Nested LLM call from an event handler: `complete()` from
  `@earendil-works/pi-ai` with `ctx.model`; pass `ctx.signal` when active.
- Skills are prompt text loaded on demand; they **cannot observe events**, so
  friction detection has to live in the extension. A skill/command is only the
  right layer for a user-initiated retrospective.

## Design

```
 input ──────────────► auto-retain user prompt → project bank        (unchanged)
 agent_end ──────────► auto-retain final answer → project bank       (unchanged)
                       friction detected this run?
                         → complete(ctx.model, last 2 turns → JSON lesson)
                         → retain to bank chosen by lesson.scope
                           tags [kind:lesson, project:<id>], context "self-learned lesson"
 hindsight_recall ───► both banks in parallel, merged, lines prefixed [user]/[project]
 hindsight_retain ─► explicit store: scope user|project, kind preference|decision|lesson
 /learn ─────────────► end-of-session retrospective; model writes via hindsight_retain
```

### Banks

- Project bank: `deriveBankId(ctx.cwd)` (unchanged).
- User bank: `process.env.HINDSIGHT_USER_BANK || "pi-agent-user"`.
- On `session_start` (once per process, module-level flag) `PATCH` the user
  bank config with a `retain_mission`:
  > Extract only durable facts about the user: preferences, conventions, tools
  > they like or dislike, communication style, recurring decisions, and
  > lessons about how they want the agent to work. Ignore project
  > implementation details.
  Fire-and-forget like retention; failure is silent.

### Tags (the "kind of memory" dimension)

- `kind:preference` · `kind:decision` · `kind:lesson`
- `project:<projectBankId>` on every user-bank item so recall can show where a
  fact was learned.
- Item `context` mirrors the kind (e.g. `"user preference"`,
  `"self-learned lesson from a user correction"`) so extraction is shaped.

### `hindsight_recall` (modify)

- New optional param `scope: StringEnum(["both","project","user"])`, default
  `both`.
- `Promise.all` over the selected banks; concatenate results, dedupe by
  `text`, sort by `scores.final` desc; each line prefixed `[user]` or
  `[project]`. Partial failure of one bank → still return the other, mention
  the failure in the text.
- `details: { banks, resultCount }`.
- Update description/guidelines: memory is user-wide **and** per-project;
  call before acting on anything the user might have a standing preference
  about; call when a task resembles something that went wrong before.

### `hindsight_retain` (new tool)

```ts
Type.Object({
  scope: StringEnum(["user","project"] as const),
  kind:  StringEnum(["preference","decision","lesson"] as const),
  content: Type.String({ minLength: 8 }),
  why: Type.Optional(Type.String()),
})
```

- Retains one item to the chosen bank, `async: true`, tags/context as above,
  `why` appended to `content` as " — because …" when present.
- Guidelines: use `hindsight_retain` with `scope: user` whenever the user
  states a preference or convention that is not specific to this repo
  ("always use bun", "no em dashes", "ask before committing"); `scope:
  project` for decisions about this codebase; `kind: lesson` when you realise
  mid-run that you lacked context you should have had.

### Self-learn autopilot

Per-run friction flags, tracked in module state and reset on `agent_end`:

| Signal | Where | Rule |
| --- | --- | --- |
| User correction | `input` | prompt (lowercased, trimmed) starts with one of `no`, `no,`, `nope`, `wrong`, `not that`, `actually`, `i said`, `i told you`, `instead`, `don't`, `stop` — flags the *previous* run |
| Tool errors | `tool_result` | ≥ 2 results with `isError` in one run, or the same bash `command` erroring twice |
| Abort + re-prompt | `agent_end` / `input` | run ended via abort and the next prompt arrives |

Keep the marker list tiny; a false positive costs one LLM call that returns
"no lesson".

When a run is flagged, in `agent_end` (after auto-retention):

1. Build a transcript of the last two turns (previous user prompt, previous
   final answer, correcting prompt, and the errored tool calls' names +
   truncated error text). Cap at ~6 000 chars.
2. `complete(ctx.model, …)` with a strict instruction to answer JSON:
   ```json
   { "has_lesson": bool, "lesson": "...", "missing_context": "...",
     "correct_behavior": "...", "scope": "user"|"project", "confidence": 0-1 }
   ```
   Parse defensively; discard when `has_lesson=false` or `confidence < 0.6`.
3. Retain one sentence to the bank picked by `scope`:
   > When ⟨situation⟩, ⟨correct_behavior⟩ — the agent previously ⟨mistake⟩
   > because it did not know ⟨missing_context⟩.
   `context: "self-learned lesson from a user correction"`,
   `tags: ["kind:lesson", "project:<id>"]`.
4. If `ctx.hasUI`, `ctx.ui.notify("Lesson stored: …", "info")` (truncated) so
   the user can see what was learned and undo via Hindsight if wrong.

Everything is fire-and-forget; never surfaces as a session error.

### `/learn` command (+ small skill)

- `pi.registerCommand("learn", …)`: `pi.sendUserMessage` with a retrospective
  prompt: review this session for (a) user preferences stated, (b) project
  decisions made, (c) places you were corrected or went down a wrong path;
  store each with `hindsight_retain`; finish with a short list of what was
  stored.
- Optional skill `skills/hindsight-memory/SKILL.md` carrying the same
  instructions so the model can run it unprompted at the end of long sessions.
  Ship the command first; add the skill only if the command proves useful.

## Phases

1. **Two banks** — `USER_BANK`, bank-config patch on `session_start`, merged
   `hindsight_recall` with `scope`, `hindsight_retain`, README update.
   → verify: in repo A, `hindsight_retain(scope:user, …)`; in repo B,
   `hindsight_recall` returns it prefixed `[user]`; `bun run check` clean.
2. **Self-learn autopilot** — friction flags, lesson extraction, retain.
   → verify: deliberately correct the agent ("no, use bun"), then
   `GET /v1/default/banks/pi-agent-user/memories/list` shows a `kind:lesson`
   item; a run with no friction stores nothing extra.
3. **`/learn` command** → verify: after a session with a stated preference,
   `/learn` stores it and recall finds it from another project.

## Later (explicitly deferred)

- Mental model "user profile" in the user bank once reflect works on the
  deployment.
- Per-turn recall injection into the system prompt (rejected for now; revisit
  if lessons are stored but not being recalled).
- `document_id`-based dedupe of repeated lessons; rely on Hindsight
  observation consolidation for now.

## Non-goals

- No client-side classification of prompts into user vs project.
- No new extension directory, no dependencies, no build step.
- No storage of intermediate tool calls/results as memories (only the
  extracted lesson sentence).
