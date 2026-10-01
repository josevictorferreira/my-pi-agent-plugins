# Implementation Plan: `subagents` Extension (tmux-visible subagents with async hand-back)

Written against the installed Pi API (`@earendil-works/pi-coding-agent` 0.84.2 types, `pi` 0.87.1 binary, tmux 3.7c) and the conventions in `AGENTS.md`. Design decisions were settled in the brainstorming session of 2026-10-01; the choices and their alternatives are recorded in §6 so they are not re-litigated during implementation.

---

## 1. Goal

Let any Pi agent delegate a task to a **subagent**: a separate, fully interactive `pi` process running in its own tmux pane, in the same working directory, with a type-specific system prompt, model, tool allowlist and skill set. The user can watch and type into every pane. When a subagent finishes a turn, the launching agent is **interrupted** with the result (Pi `steer` delivery), decides what to do, and continues. Agents can check, message and close their subagents; subagents can launch subagents of their own. All of this is persisted per root session so the tree survives restarts of the launcher and can be listed by the user.

Four built-in types ship: **explorer** (fast local code-base recon), **researcher** (web and documentation research with sources), **worker** (implementation), **oracle** (second opinion before acting). Each type's model, fallback model, extra prompt text, skills and tools are user-configurable.

### Non-goals
- No dependency scheduling between tasks ("run B after A"). The persisted graph is a **launch tree**, nothing more (§6.2).
- No result piping between sibling tasks. The launching agent reads results and composes the next prompt itself.
- No streaming of the child's tool calls into the parent's tool result (that is what Pi's bundled `subagent` example does; we deliberately diverge, §2.1).
- No parallel/chain tool modes. One `subagent_launch` call launches one task; the model calls it several times for parallelism.
- No per-launch model/tool overrides in the tool parameters. Configuration is per type (§3.6).
- No Windows or non-tmux backends. `tmux` missing is a readable tool error.
- No automatic installation of anything; no retries beyond the single fallback-model switch (§3.8).

---

## 2. Findings that shape the design

1. **Pi already ships a subagent example** (`node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`). It spawns `pi --mode json -p --no-session`, blocks the tool call until the child exits, and describes agent types as markdown with frontmatter (`name`, `description`, `tools`, `model`). It has no tmux, no async hand-back, no check/send/close, no persisted tree, no fallback. We reuse its **frontmatter vocabulary** for user overrides and its **`--append-system-prompt <tmpfile>`** trick, and nothing else.
2. **Asynchronous hand-back is native.** `pi.sendMessage(msg, { deliverAs: "steer", triggerTurn: true })` queues a custom message that is delivered after the current assistant turn finishes executing its tool calls and before the next LLM call, and starts a turn if the agent is idle (`docs/extensions.md` §"pi.sendMessage"). `"followUp"` would wait for the whole run; `"nextTurn"` (what skill-state uses) would wait for the user. `steer` is the behaviour the requirement describes.
3. **The CLI carries every per-type setting.** `--model`, `--tools <allowlist>`, `--no-skills` + repeated `--skill <path>`, `--append-system-prompt <text|file>`, `--session-id <id>` ("creating it if missing"; rejected only when combined with `--session/--continue/--resume`; the id must match `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`, which a UUID does), `-n <name>`, and a trailing positional message that starts the first turn in interactive mode.
4. **Unknown names in `--tools` are ignored, not rejected** (`dist/core/agent-session.js`: "Only tools in the registry can be enabled. Unknown tool names are ignored."). A type may therefore list `codegraph_explore` or `web_search` and still launch when that sibling extension is absent.
5. **Extension discovery is inherited.** The child is a normal `pi` run, so this package (installed via `pi install`) loads in the child too. The child-role hooks are enabled by an environment variable, not by `-e`, which avoids double-loading the extension and keeps `-e extensions/subagents/index.ts` usable for manual tests.
6. **tmux ≥ 3.2 supports `-e KEY=VAL`** on `new-session`, `new-window` and `split-window`, and `-P -F '#{pane_id}'` prints the created pane id. The command after the options is one string run through the user's shell, so the `pi` argv must be shell-quoted by us (§3.4). A pane closes when its command exits (default `remain-on-exit off`), so "pane id no longer listed" is a reliable "child exited" signal.
7. **Pi only flushes a session file once it has an assistant message** (same finding that motivated `skill-state/checkpoints.ts`). The task registry therefore lives in its own directory under `getAgentDir()`, keyed by cwd like skill-state, and never in the repo.
8. **Pi auto-retries some provider errors itself.** `agent_settled` fires only once Pi will not continue on its own (`notify` relies on this). Both the result hand-back and the fallback-model switch hook `agent_settled`, then inspect the last assistant message on `ctx.sessionManager.getBranch()` exactly as `notify/index.ts:90-105` does.
9. **Models are switched with `pi.setModel(model)`** (`ExtensionAPI`, returns `Promise<boolean>`), where the `Model` object comes from `ctx.modelRegistry.find(provider, id)`. The current model is `ctx.model` (`Model | undefined`). So a child can fall back by itself without the parent relaunching it.
10. **`pi.exec(cmd, args, { timeout, cwd, signal })`** spawns without a shell and returns `{ stdout, stderr, code, killed }`. Every tmux call goes through it; nothing imports `node:child_process`.
11. **Sibling tool names available for defaults**: built-ins `read, bash, edit, write, grep, find, ls`; this package adds `codegraph_explore`, `codegraph_node`, `lsp`, `web_search`, `web_fetch`, `context7_resolve_library_id`, `context7_query_docs`, `hindsight_recall`, `hindsight_retain`.

---

## 3. Design

### 3.1 Layout

```
extensions/subagents/
├── index.ts     # factory: tools, /subagents, poller + steer hand-back, shutdown cleanup, child-role switch
├── child.ts     # child-role hooks: status/result writing, inbox polling, fallback-model switch
├── state.ts     # task registry: root dir, task files, atomic writes, tree listing, ids
├── tmux.ts      # ensureSession, spawnPane, listPanes, killPane, killSessionIfEmpty, shellQuote
├── types.ts     # built-in type definitions (hard-coded prompts), user override loading, system-prompt assembly, skill resolution
└── README.md    # user contract: tools, env vars, config files, tmux usage, limits
```

Style: two-space indentation, direct string concatenation, TypeBox parameters, as in `extensions/skill-state/`. Built-in prompts are TS string constants like `BUILTIN_SPEC` in `extensions/skill-state/workflow.ts:9`, so nothing needs to locate markdown files next to the loaded source.

### 3.2 Roles and identity

Every Pi process loads the extension and gets the **launcher role**: four tools and one command (§3.5). A process additionally gets the **child role** (§3.7) when `PI_SUBAGENT_TASK` is set in its environment.

Identity is carried by three environment variables set on the pane, nothing else:

| Variable | Value | Used for |
| --- | --- | --- |
| `PI_SUBAGENT_TASK` | task id (= the child's `--session-id`) | child finds its own task file |
| `PI_SUBAGENT_ROOT` | root session id | state directory and tmux session name; inherited unchanged by grandchildren |
| `PI_SUBAGENT_PARENT` | launching process's session id | written into the task file; `subagent_check/send/close` only act on tasks whose `parentSessionId` equals the caller's own session id |

`rootSessionId()` is `process.env.PI_SUBAGENT_ROOT ?? ctx.sessionManager.getSessionId()`. A task id is `crypto.randomUUID()` so it is a valid Pi session id; UIs show the first 8 characters.

### 3.3 State on disk (`state.ts`)

```
~/.pi/agent/subagents/<cwd slug>/<rootSessionId>/
└── tasks/
    ├── <taskId>.json        # TaskRecord, see below
    ├── <taskId>.result.md   # last final assistant text of the child; overwritten each turn
    ├── <taskId>.inbox.jsonl # follow-ups from the parent, one {"at","text"} per line
    └── <taskId>.system.md   # assembled system prompt passed via --append-system-prompt
```

`<cwd slug>` is `cwd.replace(/[^A-Za-z0-9]/g, "-")`, identical to `skill-state/checkpoints.ts:19`. `getAgentDir()` comes from `@earendil-works/pi-coding-agent`.

```ts
export interface TaskRecord {
  id: string;
  parentSessionId: string;
  rootSessionId: string;
  type: string;                 // "explorer" | "researcher" | "worker" | "oracle" | user-defined
  title: string;
  prompt: string;               // task instructions as given by the launcher
  model?: string;               // "provider/id" the child was asked to use (undefined = Pi default)
  fallbackModel?: string;
  paneId?: string;              // tmux "%N"
  sessionFile?: string;         // written by the child on session_start
  status: "starting" | "running" | "idle" | "exited" | "closed";
  turns: number;                // completed agent_settled count in the child
  lastStopReason?: string;      // from the child's last assistant message
  fellBack?: boolean;           // child switched to fallbackModel
  createdAt: string; updatedAt: string; closedAt?: string;
}
```

**Writer discipline (why one file per task instead of one `dag.json`).** The launcher writes the record once, before the pane exists. From then on only the child writes it (status, turns, sessionFile, fellBack). The closer writes `status: "closed", closedAt` only after the pane is gone. Two subagents launching grandchildren concurrently touch different files. No locks. Every write is `writeFile(tmp) → rename` so readers never see a partial JSON. The only tolerated race is the child's `session_shutdown` write landing after the closer's write; readers treat `closedAt` as authoritative for display.

**Tree** = all `tasks/*.json` under the root dir, linked by `parentSessionId === parent.id` (a child's session id is its task id). `listTree(root)` returns records sorted by `createdAt`; `childrenOf(sessionId)` filters by parent. The main session's own id is the tree root and has no record.

### 3.4 Launch (`tmux.ts` + `subagent_launch`)

```
subagent_launch({ type, title, prompt })
  → def = resolveType(type)                      # §3.6; unknown type → tool error listing known types
  → skills = resolveSkills(def.skills, cwd)      # unresolvable name → tool error, nothing launched
  → piBin = first existing <dir>/pi on process.env.PATH  (missing → tool error)
  → id = randomUUID(); write <id>.system.md; write TaskRecord{status:"starting"}
  → argv = [piBin, "--session-id", id, "-n", type + ": " + title,
            ...(model ? ["--model", model] : []),
            ...(def.tools ? ["--tools", def.tools.join(",")] : []),
            ...(skills ? ["--no-skills", ...skills.flatMap(p => ["--skill", p])] : []),
            "--append-system-prompt", systemFile, "--", prompt]
  → paneId = spawnPane(sessionName, cwd, env, argv.map(shellQuote).join(" "))
  → update record { paneId }; startPoller(); return text + details { taskId, paneId, tmuxSession }
```

`model` is `def.model ?? (ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined)`: a type without a configured model inherits the **launcher's current model**, so a Worker launched from a strong model is not silently demoted to Pi's global default.

**tmux session**: name `pi-` + first 8 chars of the root session id. `spawnPane`:
1. `tmux has-session -t <name>` (exit 0 = exists).
2. If missing: `tmux new-session -d -s <name> -n subagents -c <cwd> -e K=V... -P -F '#{pane_id}' <cmd>`; the first subagent *is* the first pane, so no idle shell pane is left behind.
3. Else: `tmux split-window -t <name>:subagents -c <cwd> -e K=V... -P -F '#{pane_id}' <cmd>`; if that fails because the window was closed or renamed, `tmux new-window -t <name> -n subagents ... <cmd>`.
4. `tmux select-layout -t <name>:subagents tiled`.

`shellQuote(s)` wraps in single quotes with `'` → `'\''`; the prompt is passed as one argument after `--` so a prompt starting with `-` is still a message. tmux runs the string through the user's default shell. All descendants of one root land in the same tmux session; a user who runs the main Pi outside tmux attaches with `tmux attach -t <name>`, which `/subagents` prints.

**Poller** (launcher role, `index.ts`): a `setInterval` of 1500 ms that runs while this process has any task not in `exited`/`closed`. Each tick: one `tmux list-panes -s -t <name> -F '#{pane_id}'` (session gone ⇒ empty set), then for each of my tasks read the record and:
- `turns` increased and `status === "idle"` ⇒ hand back (below), remember the turn number.
- `paneId` not in the set and status not terminal ⇒ write `status: "exited"` (the child did not get to write it) and hand back once with "exited without a result" or with the last result if one exists.
- When nothing is left to watch, clear the interval.

**Hand-back**: `pi.sendMessage({ customType: "subagent-result", display: true, content, details: { taskId, type, title, status, turns, model } }, { deliverAs: "steer", triggerTurn: true })`. `content` is:

```
subagent <type> "<title>" (<id8>) finished turn <n> [stopReason: error] [fell back to <model>]

<result.md, capped at 8 KB; if cut: "... [truncated; call subagent_check for the full result]">

The subagent is still open: reply with subagent_send to continue it, or subagent_close when done.
```

Sending happens once per completed turn, including turns triggered by `subagent_send` and by the user typing into the pane.

### 3.5 Tools and command

All tools register with `pi.registerTool({...})` directly (they write and spawn, so **not** `stateRunTool`, per `AGENTS.md`). Parameters are TypeBox objects with descriptions, after `extensions/web-tools/index.ts:76-100`. Every tool returns `{ content: [{ type: "text", text }], details }` and reports failures as text with `details.error`, never by throwing.

| Tool | Params | Behaviour |
| --- | --- | --- |
| `subagent_launch` | `type` (string), `title` (string, ≤ 80), `prompt` (string) | §3.4. Text: `launched <type> "<title>" as <id8> in tmux <name> pane %N`. |
| `subagent_check` | `taskId?` (string, id or unique 8-char prefix) | Own tasks only. Per task: status, model (+`fell back`), turns, last stop reason, result capped at 16 KB, and when `sessionFile` is readable the last 10 tool calls from it as `name(args ≤ 80 chars)`. Without `taskId`: one line per own task. |
| `subagent_send` | `taskId`, `message` | Own task, status not `exited`/`closed` ⇒ append `{at, text}` to the inbox. Text confirms queued; the result arrives later via the normal hand-back. |
| `subagent_close` | `taskId` | Own task. Close descendants first (depth-first, by `childrenOf`), then `tmux kill-pane -t %N`, wait ≤ 3 s for the pane to disappear from `list-panes`, write `closed`. Already-exited tasks are just marked closed. |

Command `/subagents [--all]`: prints the tree of the current root (indent by depth): `<id8> <type> "<title>" <status> turns=<n> <model>` plus the attach hint. With `--all` it lists every root directory under the cwd slug, newest first, so earlier sessions' trees remain readable as history. It is UI-only: the listing goes through `ctx.ui.notify` and no message is sent to the model.

`promptGuidelines` on the tools tell the model: launch for independent, well-bounded work; results arrive as `subagent-result` messages, so **do not poll with `subagent_check`**; close subagents you no longer need.

### 3.6 Types and configuration (`types.ts`)

```ts
export interface SubagentType {
  name: string;
  description: string;
  prompt: string;           // built-in body; user body is appended
  tools?: string[];         // undefined = no --tools flag (all tools)
  skills?: string[];        // undefined = inherit Pi's skill discovery
  model?: string;           // "provider/id"
  fallbackModel?: string;   // "provider/id"
}
```

Built-ins (hard-coded in `types.ts`):

| Type | `tools` | Prompt intent |
| --- | --- | --- |
| `explorer` | `read, grep, find, ls, codegraph_explore, codegraph_node, lsp` | Locate relevant files, entry points, data flow and risks; return a handoff brief with exact paths and line ranges for an agent that has not seen the files. |
| `researcher` | `read, web_search, web_fetch, context7_resolve_library_id, context7_query_docs` | Answer the question from current sources; return a research brief with a short conclusion, findings, and a sources list with URLs. |
| `worker` | *(unset)* | Implement the task in the repository; report what changed (files), how it was verified (commands and their results), and what was left undone. |
| `oracle` | `read, grep, find, ls, codegraph_explore, codegraph_node, lsp` | Give a second opinion: restate the decision, list risks and alternatives, end with one recommendation. Changes nothing. |

**User override**: `~/.pi/agent/subagents/<type>.md` (via `getAgentDir()`), optional. Frontmatter keys `model`, `fallbackModel`, `tools`, `skills` (comma-separated string or `[a, b]`) **replace** the built-in value; the markdown body is **appended** to the built-in prompt. A file whose name is not a built-in type defines a new type with `prompt` = body and unset tools/skills/model (`description` from frontmatter, required for new types). Frontmatter parsing is the same minimal `---` block / `key: value` reader as Pi's example `agents.ts`; no YAML dependency. Files are read on every launch, so edits apply without restarting Pi.

**Skill resolution** (`resolveSkills`): each entry is tried as `<agentDir>/skills/<name>`, `<cwd>/.pi/skills/<name>`, then as a path (absolute, or relative to cwd); the first existing path wins and is passed to `--skill`. Any unresolved entry fails the launch with `unknown skill "<name>" for type <type>`; a type that asks for specific skills must get them.

**System prompt** = fixed base + type prompt + user body, written to `<id>.system.md`:

> You are a **<type>** subagent launched by another agent, not by a person. Your task is the first user message. Work only on that task in this repository. Each time you stop, the whole of your final message is delivered verbatim to the launching agent, which has not seen your tool calls, so make it self-contained: what you found or did, exact file paths, and anything it must decide. Do not ask for clarification unless you are blocked; if you are, end your message with the one question you need answered. Follow-up instructions may arrive as new user messages.

### 3.7 Child role (`child.ts`)

Enabled when `PI_SUBAGENT_TASK` is set. Hooks:

- `session_start` → write `sessionFile = ctx.sessionManager.getSessionFile()` and `status: "running"` (the first turn starts immediately from the positional prompt).
- `agent_start` → `status: "running"`.
- `agent_settled` → `last = lastAssistantMessage(ctx)` (branch walk as `notify/index.ts:90-105`); write `<id>.result.md` with its text (or the `errorMessage` when `stopReason === "error"`), then `turns + 1`, `lastStopReason`, `status: "idle"`. Fallback check runs here too (§3.8).
- **Inbox poll**: `setInterval` 1500 ms reading `<id>.inbox.jsonl` from a remembered byte offset. Each new line → `pi.sendUserMessage(text, { deliverAs: "followUp" })` while the agent is busy, plain `pi.sendUserMessage(text)` when `ctx.isIdle()`. The `ctx` used by the interval is the one captured at `session_start` (hooks receive it; timers do not). Delivered messages are never re-read (offset persists in memory; the file is append-only).
- `session_shutdown` → `status: "exited"` unless the record already has `closedAt`.

The child never talks to the parent except through these files. It does not know whether the parent is alive.

### 3.8 Fallback model

In `agent_settled`, when `lastStopReason === "error"`, `record.fallbackModel` is set and `fellBack` is not yet true:
1. `[provider, ...rest] = fallbackModel.split("/")`; `model = ctx.modelRegistry.find(provider, rest.join("/"))`. Not found ⇒ write `result.md` with the error plus `fallback model <x> not found`, no switch.
2. `await pi.setModel(model)`; write `fellBack: true`, `model: fallbackModel`.
3. `pi.sendUserMessage("The previous attempt failed with a provider error (" + errorMessage + "). The model was switched; continue the task.")` — the child's context already holds the task and any partial work, so no prompt replay is needed.

This happens once per child process. A second error is handed back to the parent like any other result (`stopReason: error` in the hand-back header), and the parent decides.

### 3.9 Shutdown and cleanup

`session_shutdown` in **any** process: for every task launched by this process that is not terminal, run the `subagent_close` logic (descendants first). Afterwards, if this process is the root (`PI_SUBAGENT_ROOT` unset) and `tmux list-panes -s -t <name>` is empty or the session is gone, `tmux kill-session -t <name>`. Task files are kept (history); `/subagents --all` in a later session of the same cwd still lists the previous roots' trees, read-only.

Rationale: quitting the main agent must not leave orphan subagents burning tokens that nobody will collect. A user who wants to keep a pane breaks it out of the session first (`tmux break-pane -d`, which keeps the pane id, so the poller still tracks it until the parent exits).

### 3.10 Failure policy

| Condition | Behaviour |
| --- | --- |
| `tmux` not on PATH, `pi` not on PATH | `subagent_launch` returns a tool error; nothing written. |
| tmux command fails (bad server, no permission) | tool error with the tmux stderr; the pre-written record is removed. |
| unknown type, unresolvable skill, unknown `taskId`, task not mine | tool error naming valid alternatives. |
| child exits before writing a result (pi crash, user `/exit`) | poller marks `exited`, hands back once. |
| parent exits while children run | `session_shutdown` closes them (§3.9). |
| parent is a `pi -p` print run | poller and hand-back work identically; the print run ends when the agent stops, so children are closed at shutdown. Documented, not special-cased. |
| state dir unwritable | `subagent_launch` fails readably; nothing else in Pi is affected. |

Caps: result in the hand-back ≤ 8 KB, result in `subagent_check` ≤ 16 KB, tool-call tail 10 entries × 80 chars. `title` ≤ 80 chars. No cap on `prompt` (it goes through the shell as one argument; tmux's command string limit is far above any realistic prompt).

---

## 4. Implementation steps

Each step ends with `bun run check` passing and a commit. Scratch scripts live in `/tmp/claude-1000/.../scratchpad` (not committed), as skill-state's behavioural checks did. ONLY use `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`, and Node built-ins (`node:fs/promises`, `node:path`, `node:crypto`, `node:os`). Touch ONLY the files listed per step plus `AGENTS.md`/`README.md` in step 6.

**Style anchors** (read before step 1, re-read before step 4):
- `extensions/skill-state/checkpoints.ts:19-36` — per-cwd directory under `getAgentDir()`, slugging, one JSON file per item.
- `extensions/skill-state/index.ts:343-346` and `:519-521` — `pi.sendMessage` with explicit delivery options; `session_shutdown` aborting active work.
- `extensions/notify/index.ts:90-105` and `:129` — last-assistant-message branch walk; `pi.exec` with a timeout, exit code checked, errors turned into one UI warning.
- `extensions/web-tools/index.ts:76-100` — `registerTool` with TypeBox parameters, `promptSnippet`, `promptGuidelines`.
- `extensions/skill-state/workflow.ts:9` — built-in prompt as a TS constant, user text appended.

### Step 1 — `state.ts` + `types.ts` (≈ 90 min)
Files: `extensions/subagents/state.ts`, `extensions/subagents/types.ts`.
- `state.ts`: `rootDir(cwd, rootId)`, `TaskRecord`, `writeTask` (tmp + rename), `updateTask(id, patch)` (read-merge-write), `readTask`, `listTree(cwd, rootId)`, `childrenOf(tree, sessionId)`, `resolveTaskId(tree, prefix)` (exact id or unique 8-char prefix), `appendInbox`, `readInboxFrom(offset)`, `writeResult`/`readResult(cap)`.
- `types.ts`: `BUILTIN_TYPES` (four, §3.6), `parseFrontmatter`, `loadUserType(name)`, `resolveType(name)` (built-in merged with override, or user-defined), `resolveSkills(entries, cwd)`, `buildSystemPrompt(def)`.
- Verify: scratch script creates two records under a fake root, lists the tree with the right parent links, resolves an 8-char prefix, rejects an ambiguous one; overrides a built-in via a temp `~/.pi/agent/subagents/explorer.md` copy and shows `tools` replaced and body appended; `resolveSkills(["brainstorming"])` resolves to `~/.pi/agent/skills/brainstorming` and `["nope"]` throws.

### Step 2 — `tmux.ts` (≈ 60 min)
File: `extensions/subagents/tmux.ts`.
- `sessionName(rootId)`, `shellQuote`, `ensureAndSpawn(exec, {name, cwd, env, command}) → paneId` implementing §3.4 steps 1–4, `listPanes(exec, name) → Set<string>`, `killPane(exec, paneId)`, `killSessionIfEmpty(exec, name)`. `exec` is `pi.exec` injected so the module is testable without Pi. Every call uses `timeout: 5000`.
- Verify: scratch script with `tmux -L subagents-test` (pass the socket via `TMUX_TMPDIR`/`-L` wrapper in the exec shim): spawn `sleep 30` twice → two distinct `%N`, `listPanes` has both, `-e` variables visible in the pane (`tmux show-environment -t` or a `sh -c 'echo $PI_SUBAGENT_TASK > file'` command), `killPane` removes one, `killSessionIfEmpty` after the second. `shellQuote` round-trips a prompt containing `'`, `"`, `$HOME`, newlines through `sh -c 'printf %s ...'`.

### Step 3 — `child.ts` + role switch in `index.ts` (≈ 90 min)
Files: `extensions/subagents/child.ts`, `extensions/subagents/index.ts` (factory skeleton only).
- `index.ts`: `export default function (pi)`; `if (process.env.PI_SUBAGENT_TASK) registerChild(pi)`; launcher parts are stubs until step 4.
- `child.ts`: hooks from §3.7, fallback from §3.8, `lastAssistantMessage` copied from notify's pattern (shared helper not extracted: two small copies beat a cross-extension import, matching how `tts` and `notify` already duplicate it).
- Verify: write a fake record, then run `PI_SUBAGENT_TASK=<id> PI_SUBAGENT_ROOT=<root> PI_SUBAGENT_PARENT=p pi -ne -nc -ns -np -e extensions/subagents/index.ts --session-id <id> -p "Reply with the single word pong"` with a cheap model (the session is kept on purpose: `--session-id` is how `sessionFile` gets set) → record shows `turns: 1`, `status: "idle"` then `"exited"`, `sessionFile` set, `result.md` contains `pong`. Fallback: set `fallbackModel` to a real model and `--model` to a non-existent provider id → `fellBack: true` and the result comes from the fallback model.

### Step 4 — launcher: tools, poller, hand-back, `/subagents` (≈ 150 min)
File: `extensions/subagents/index.ts`.
- `subagent_launch`, `subagent_check`, `subagent_send`, `subagent_close`, `/subagents`, poller and hand-back per §3.4–3.5. Module state: `watching: Map<taskId, lastHandedTurn>`, `interval`.
- Verify (manual, on the user's real tmux server, since the launcher always targets it; the root session is disposable): in this repo, `pi -e extensions/subagents/index.ts`, ask it to "launch an explorer titled 'lsp entry points' to list where extensions/lsp registers tools and hooks, then wait". Observe: pane appears tiled in `pi-<id8>`, explorer runs with only read tools, parent is interrupted with a `subagent-result` message and summarises it, `/subagents` lists one `idle` task, `subagent_send` makes the explorer continue and a second hand-back arrives, `subagent_close` removes the pane and the tree shows `closed`. Then quit the parent and confirm the tmux session is gone.

### Step 5 — shutdown cleanup, nested launch, print-mode pass (≈ 60 min)
File: `extensions/subagents/index.ts`.
- `session_shutdown` per §3.9; `rootSessionId()` inheritance; `PI_SUBAGENT_ROOT` propagation to grandchildren.
- Verify: launch a worker, have the worker launch an explorer (tell it to), confirm both panes are in the same tmux session and the worker (not the root) is interrupted by the explorer's result; `subagent_close` on the worker closes both; quitting the root with children open kills every pane and the session. Print-mode: `pi -p -e extensions/subagents/index.ts "launch an explorer ... and summarise"` ends with children closed.

### Step 6 — docs and knowledge base (≈ 45 min)
Files: `extensions/subagents/README.md`, `AGENTS.md`, root `README.md`.
- README: tools and their parameters, hand-back message format, env vars, override file format with a full example, skill resolution rules, tmux attach/break-pane notes, limits and failure policy, the manual verification recipe from steps 3–5.
- `AGENTS.md`: structure entry, WHERE TO LOOK rows (launch flow, child role, type config), UNIQUE STYLES paragraph (roles switched by `PI_SUBAGENT_TASK`, file-per-task registry under the agent dir, `steer` hand-back, all descendants of one root share one tmux session), CODE MAP rows for `ensureAndSpawn`, `resolveType`, `registerChild`.

### Optional step 7 — quiet siblings in child processes (≈ 20 min, separate commit)
Files: `extensions/notify/index.ts`, `extensions/hindsight/index.ts`.
- Early-return when `process.env.PI_SUBAGENT_TASK` is set: no desktop notification per subagent turn, no memory retention of subagent prompts. One line each; left optional because it touches other plugins.

---

## 5. Verification summary (definition of done)

- `bun run check` passes after every step.
- Step 1–3 scratch checks pass as described; outputs pasted into the commit message body or the README's verification section.
- The step 4–5 manual scenario works end to end: visible tiled panes, parent interrupted with the result, send/check/close behave, nested launch shares the tmux session, root shutdown leaves no pane and no tmux session.
- `/subagents --all` in a fresh Pi session in the same cwd still lists the earlier tree (read-only history).
- Overriding `~/.pi/agent/subagents/worker.md` with `model: <cheap model>` and a body line changes the launched worker's model (visible in its pane header) and its system prompt (ask it to quote the appended line).
- No new dependencies in `package.json`; no files in the repo written at runtime.

---

## 6. Decisions taken and alternatives rejected

1. **Interactive TUI child + child-role hooks** (chosen) vs print-mode child through a renderer vs `--mode rpc` with the pane as a log mirror. Chosen because the pane must be watchable and typeable and the task must outlive its first turn (check/send/close). Print mode cannot take follow-ups; rpc makes the pane read-only and needs the most code.
2. **Launch tree only** (chosen) vs tree + dependency scheduling vs tree + result-handoff edges. Scheduling needs pending states, cycle checks and failure propagation; handoff edges can be emulated by the parent composing prompts from results.
3. **`subagent_send` exists** (chosen) vs launch/check/close only. Nearly free once the child role polls an inbox; it is what makes the Oracle useful for a second question.
4. **State under `~/.pi/agent/subagents/<cwd slug>/`** (chosen) vs `.agents/sessions/` in the repo. Matches skill-state, needs no gitignore handling, and keeps result files out of `git grep`-based repository tools.
5. **One JSON file per task** (chosen) vs one `dag.json` per root. Removes every concurrent-writer case (§3.3) at the cost of a directory listing when rendering the tree.
6. **Markdown + frontmatter overrides** (chosen) vs one JSON config vs Pi `settings.json` section. Prompt text is the main thing users edit; markdown is the natural medium and matches Pi's own skills and its subagent example.
7. **Fallback inside the child** (chosen) vs parent relaunch. Keeps the pane, session and partial work; the parent only sees `fell back to <model>` in the hand-back header.
8. **Tiled panes in one window** (chosen, as requested) vs one window per subagent. Panes show everything at once; past four concurrent subagents it gets cramped, documented with `tmux break-pane` as the escape hatch.
9. **Kill the subtree on `session_shutdown`** (chosen) vs leave panes running. Orphans would keep spending tokens with nobody to collect results.
10. **Inherit the launcher's model when the type has none** (chosen) vs Pi's global default. Avoids silently demoting a Worker launched from a strong model.
11. **Poll task files every 1.5 s** (chosen) vs `fs.watch`. Polling also detects dead panes with the same `list-panes` call and avoids inotify edge cases; one `tmux` exec and a few small file reads per tick is negligible.

---

## 7. Risks and open points

1. **tmux server environment.** Panes inherit the tmux *server's* environment plus the `-e` variables, not the parent `pi` process's environment. If the server was started from a shell without the provider API keys that the parent has, children fail to authenticate. Mitigation in v1: resolve `pi` to an absolute path so PATH differences do not matter, and document `tmux set-environment -g` / starting tmux from a configured shell. Possible follow-up: `PI_SUBAGENT_ENV=VAR1,VAR2` to forward named variables with `-e`.
2. **Shell quoting of the prompt.** The command string runs through the user's default shell (`default-shell`, may be fish or zsh). Single-quote quoting is portable across sh, bash, zsh and fish for everything except fish's handling of `\'` — fish accepts `'\''` as well. Verified in step 2 against the actual default shell.
3. **`agent_settled` in the child fires once per completed turn, including turns the user starts by typing into the pane.** Each one is handed back to the parent. That is the intended behaviour, but a chatty user in a pane produces chatty interruptions; documented.
4. **`steer` interrupts between tool calls, not mid-generation.** If the parent is in a long generation, the result lands before its next LLM call, which is the documented semantics; there is no way (and no need) to abort the current generation.
5. **Pi version skew.** Installed `pi` is 0.87.1, types are 0.84.2. Everything used here (`sendMessage` delivery modes, `setModel`, `modelRegistry.find`, `exec`, `getAgentDir`, the events) exists in both; `--session-id` and `-e` on tmux are runtime facts of the installed binary and tmux. If `pi update` moves the types, re-run `bun run check` first.
6. **Sibling extensions inside children** (notify popups per turn, hindsight retention of subagent prompts, codegraph auto-init already running in the parent). Optional step 7 silences the first two; codegraph's background init is idempotent (`.codegraph` exists after the first run) so it is harmless.
7. **Pane title**: Pi's `-n` names the Pi session, and the tmux pane shows the process name unless `pane-border-status` is enabled. Follow-up idea: `tmux select-pane -T "<type>: <title>"` after spawn (`pane-border-format` then shows it); costs one more tmux call, decide during step 4 by looking at the actual screen.
