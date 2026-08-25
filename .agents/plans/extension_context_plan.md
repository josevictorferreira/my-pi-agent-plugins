# Extension Context Plan — teaching the agent when/where/how to use our tools

**Date:** 2026-08-25 · **pi version researched:** 0.84.2 (installed) and pi.dev/docs/latest (identical mechanisms)

## Problem

The package registers 14 tools across 5 extensions (plus 2 command-only extensions). Registering a
tool gives the model its schema, but not a *policy*: when to reach for `codegraph_explore` instead of
grep, when `lsp` beats both, when to consult `context7` before `web_search`, when to `hindsight_recall`
unprompted. Today that policy is partial, inconsistent across extensions, and has one rendering bug.

## How pi lets an extension "teach" the model (research findings)

Everything the model ever sees comes from one of these layers. Ordered from cheapest/most-targeted to
most expensive/most-global (`core/system-prompt.js`, `docs/extensions.md`, `docs/skills.md`, `docs/usage.md`):

| # | Layer | Where it lands | Answers | Who owns it | Cost |
|---|-------|----------------|---------|-------------|------|
| 1 | `description` + parameter `description`s in `registerTool` | Tool schema sent on every request | **How** to call it, what comes back | package | always paid, per tool |
| 2 | `promptSnippet` | `Available tools:` list, rendered `- <name>: <snippet>` — tools **without** a snippet are not listed at all | **What exists** | package | 1 line/tool |
| 3 | `promptGuidelines` | Flat bullets in `Guidelines:`, deduped, only while the tool is active; **must name the tool** ("Use lsp when…", never "Use this tool…") | **When** / when **not** / in what **order** | package | 1–2 lines/tool |
| 4 | Skills (`SKILL.md`, shipped via `skills/` or `pi.skills`) | `<available_skills>` name+description in prompt; body loaded on demand via `read` or `/skill:name` | **Multi-step workflows** with fallbacks, setup, examples | package | description always; body only when read |
| 5 | `before_agent_start` → `systemPrompt` / `message` | Per-turn; can inspect `event.systemPromptOptions.selectedTools` and append conditional text, or inject a message | **Dynamic, conditional** context (e.g. "index present", recalled memories) | package | every turn it fires |
| 6 | Context files (`~/.pi/agent/AGENTS.md`, project `AGENTS.md`), `APPEND_SYSTEM.md` | `<project_context>` block | User/project conventions & cross-tool policy | **user, not shippable** | always |
| 7 | Prompt templates (`prompts/*.md`) | Only when the user types `/name` | User-triggered workflows | package | zero unless used |

Key constraints discovered:

- `promptGuidelines` is the only shipped, always-on place for a *when* rule; it is per-tool and appended
  flat, so cross-tool ordering ("prefer A over B, fall back to C") must either be phrased inside one
  tool's guideline or delivered via layers 4–6.
- Snippets are prefixed by pi with `- <name>: `. Ours already start with `name:`, so today the prompt
  reads `- codegraph_explore: codegraph_explore: semantic search…`.
- `promptSnippet`/`promptGuidelines` are picked up even for tools registered late (codegraph registers
  in `session_start`) — no `/reload` needed.
- Skills only appear if the `read` tool is active; descriptions ≤1024 chars decide whether the model
  ever opens them. Models frequently *don't* open them unless the description is specific.
- `before_agent_start` text is chained across extensions and costs tokens every turn — reserve it for
  information that genuinely changes per session/turn.
- A package cannot ship AGENTS.md/APPEND_SYSTEM.md; those are the user's. `~/.pi/agent/AGENTS.md`
  currently contains only coding principles — no tool-strategy section.

## Current state audit

| Extension | Tools | Snippet | Guidelines | Gaps |
|-----------|-------|---------|------------|------|
| codegraph | 7 (2 default: explore, node) | explore only, `name:` double prefix | explore, node | no "when not" (index stale / unavailable); no ordering vs lsp/grep |
| lsp | 1 | yes, double prefix | yes | doesn't say diagnostics arrive automatically after edit/write, so model may call `lsp diagnostics` redundantly |
| context7 | 2 | on resolve only, worded as "context7:" | on query_docs only | two-step protocol is split across two tools; no fallback to web tools |
| web-tools | 2 | one snippet on web_search covering both; web_fetch absent from list on its own | yes | should not be first choice for library docs when context7 exists |
| hindsight | 2 + `/learn` | yes ×2, double prefix | yes ×2 (good, model-facing "when") | recall is model-discretion; no auto-recall injection |
| tts / stt | 0 (commands + keybindings) | n/a | n/a | correctly no model-facing surface — nothing to do |

## Design decision

Use the cheapest layer that can express each kind of knowledge, and don't duplicate:

1. **How** → `description` / param descriptions (already good; leave alone unless wrong).
2. **What exists** → one clean `promptSnippet` per tool.
3. **When / when not** → `promptGuidelines`, one or two bullets per tool, each naming the tool.
   Cross-tool preference is expressed *from the losing side* ("Use web_search for library docs only when
   context7 has no entry") so it's still correct when the preferred tool is inactive.
4. **Multi-step workflow with fallbacks** → *one* shipped skill only where the workflow has ≥3 steps
   and a fallback chain: `library-docs` (resolve → query → web_search → web_fetch). Investigating code
   (codegraph → lsp → read) is 2 steps and fits in guidelines; no skill.
5. **Dynamic context** → `before_agent_start` only in hindsight (auto-recall) and, optionally, codegraph
   (state "index exists at <path>, last indexed <date>"). Evaluate token cost before keeping either.
6. **User policy** → a short "Tool strategy" section in `~/.pi/agent/AGENTS.md` (documented in README
   as a recommendation, not shipped).

Rejected: a separate "toolkit" extension that appends a global strategy block via `before_agent_start`.
It duplicates guidelines, pays every turn, and couples extensions that are installable independently.

## Status (2026-08-25)

- Phase 1: **done** — snippets/guidelines normalised in all five tool extensions; rendered prompt verified via a throwaway `before_agent_start` dumper. READMEs did not quote prompt text, so no sync was needed.
- Phase 2: **skipped by decision** — the context7 → web fallback is covered by two guidelines; revisit only if the smoke test shows `web_search` chosen first for library questions.
- Phase 3: **done, default off** — `HINDSIGHT_AUTO_RECALL=1` injects a hidden `hindsight-recall` message per prompt via `before_agent_start`; recall/merge logic shared with the tool. First measurement: 2 banks × 600-token budget produced ~815 tokens of mostly low-signal project "experience" entries → per-bank budget lowered to 300. Flip the default only after a week shows the injected content is actually used.
- Smoke test (glm-5-3, 1–2 runs each): `codegraph_explore` ✔ for "how does X work / who uses X"; `context7_resolve_library_id → context7_query_docs` ✔ for library syntax (after wording "never answer from memory alone"); "where is X referenced" still goes to `rg` — accepted, because `lsp references` needs a file position and one `rg` locates the symbol faster; the lsp guideline now targets follow-from-position use instead of forbidding grep.
- Phase 4: **done** — README section + `## 5. Tool Strategy` in `~/.pi/agent/AGENTS.md`.

## Implementation plan

### Phase 1 — fix and normalise the static prompt surface (all `extensions/*/index.ts`)

1. Strip the `name:` prefix from every `promptSnippet`; make each ≤ ~15 words, describing capability
   not implementation.
   → verify: dump the system prompt (see Verification) and confirm each line reads `- name: snippet` once.
2. Give **every** default-enabled tool its own snippet: `web_fetch`, `context7_query_docs`,
   `codegraph_node`. Opt-in codegraph tools (`query`, `callers`, `callees`, …) also get snippets so they
   are listed when enabled via `CODEGRAPH_TOOLS`.
3. Rewrite guidelines to the pattern `Use <tool> when <trigger>; do not use it when <anti-trigger>.`
   Concrete targets:
   - `codegraph_explore`: prefer over grep/read sweeps for "how does X work / what breaks if I change X";
     do not re-read returned source; if the result reports a stale/missing index fall back to grep + read.
   - `lsp`: definitions/references/hover by position; **diagnostics are appended to edit/write results
     automatically — call `lsp diagnostics` only for files not just edited.**
   - `context7_resolve_library_id` → single guideline covering the protocol: resolve once per library per
     session, then `context7_query_docs`; use for any API/config/migration question on a third-party lib.
   - `web_search`: current events, errors, anything outside training data; **for library docs only when
     context7 has no entry**. `web_fetch`: read a URL before citing it.
   - `hindsight_recall` / `hindsight_retain`: keep current bullets (already the best-written ones);
     tighten to ≤2 bullets each.
   → verify: `bun run check`; prompt dump shows no bullet starting with "Use this"/"It".
4. Move the tool-contract text in each `README.md` into sync with the new snippets/guidelines (READMEs
   are the documented source of truth per AGENTS.md).

### Phase 2 — `skills/library-docs/SKILL.md` (new, shipped via `"pi": { "skills": ["./skills"] }`)

- Description (drives loading): "Look up current documentation for a third-party library, framework or
  SDK — API syntax, config, migrations, version differences. Use before answering from memory."
- Body: the 4-step chain (resolve → query with `topic` → if unresolved, `web_search "<lib> docs <topic>"`
  → `web_fetch` the official page), when to skip context7 (private/internal libs), how to cite.
- Add `skills/` to the convention dirs in README and AGENTS.md structure table.
  → verify: startup header lists the skill; `/skill:library-docs` loads it; a prompt like "how do I
  configure X in library Y" results in a resolve → query tool sequence.

### Phase 3 — hindsight auto-recall via `before_agent_start` (opt-in, `HINDSIGHT_AUTO_RECALL=1`)

- On each user prompt (skip the same trivial/slash inputs auto-retain skips), query both banks with
  the prompt, budget ≈600 tokens, and return `{ message: { customType: "hindsight-recall", content,
  display: false } }` only when something came back.
- This removes the "model must decide to recall" dependency, which is the weakest link in memory use.
  → verify: with a stored preference, a related prompt shows the injected message in the session file
  and the answer honours the preference without an explicit `hindsight_recall` call. Measure added
  tokens/turn over ~10 turns; keep the flag default-off if median > ~500.

### Phase 4 — user-side policy (documentation only)

- README section "Teaching pi to use these tools" explaining layers 2–4 above and recommending a
  `## Tool strategy` block for `~/.pi/agent/AGENTS.md`, e.g. order of investigation
  (codegraph → lsp → grep/read), docs (context7 → web), memory (recall before acting on preferences).
- Explicitly note tts/stt are user-invoked and intentionally invisible to the model.

## Verification

1. **Prompt dump**: throwaway `.pi/extensions/dump-prompt.ts` registering `/prompt` that prints
   `ctx.getSystemPrompt()` (inside `before_agent_start` it reflects all chained changes). Check
   rendering after Phase 1 and token size after Phase 3. Not committed.
2. **Typecheck**: `bun run check` after every phase.
3. **Behavioural smoke test** (manual, `pi -p --mode json "<prompt>"`, grep the first tool call):

   | Prompt | Expected first tool |
   |--------|---------------------|
   | "How does the LSP client handle shutdown?" (in a codegraph-indexed repo) | `codegraph_explore` |
   | "Where is `loadConfig` referenced?" | `lsp` (references) |
   | "What's the current TypeBox syntax for optional enums?" | `context7_resolve_library_id` |
   | "What changed in pi 0.85?" | `web_search` |
   | "Do I prefer tabs or spaces?" | `hindsight_recall` (Phase 3: no call, injected memory) |

   Run each 3× against the daily model; a target of ≥2/3 correct first calls per row.

## Out of scope

- Changing what tools return (`details`, caps) — only their prompt surface.
- New tools or tts/stt changes.
- Prompt templates: none of these workflows is user-triggered often enough to justify one yet.

## Open questions for the user

1. Ship the `library-docs` skill (Phase 2) or keep the protocol purely in guidelines? Skill = better
   fallback handling; guidelines = zero always-on prompt cost beyond ~2 lines.
2. Is per-turn auto-recall (Phase 3) worth ~1 extra HTTP round-trip and a few hundred tokens per prompt?
