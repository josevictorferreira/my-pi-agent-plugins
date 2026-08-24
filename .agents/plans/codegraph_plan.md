# Implementation Plan: `codegraph` extension (semantic code search & exploration)

## Goal

Add a new pi extension at `extensions/codegraph/` that exposes
[CodeGraph](https://github.com/colbymchenry/codegraph) code intelligence as
native pi tools, by shelling out to the already-installed `codegraph` CLI.

**Reference:** [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)
(`packages/omo-codex/plugin/components/codegraph/`, `packages/utils/src/codegraph/`).
OMO wires CodeGraph in as an **MCP server** (`codegraph serve --mcp`) behind a
bridge that adds binary resolution, Node-version gating, auto-provisioning,
session-start auto-`init`, daemon zombie sweeping and init-guidance hooks.

**We deliberately do not copy that architecture**, for one hard reason and one
soft one:

1. **pi has no MCP.** `docs/usage.md:304` — *"It intentionally does not include
   built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background
   bash."* Using the MCP server would mean writing a JSON-RPC stdio bridge
   inside the extension (OMO's `mcp-bridge.ts` is ~11KB of framing, response-mode
   tracking and child lifecycle management) just to reach tools we can reach
   directly.
2. **The CLI is at full parity with the MCP surface.** CodeGraph's own README
   says so explicitly for every tool: `codegraph explore` is *"same output as the
   `codegraph_explore` MCP tool"*, `codegraph node` is *"same output as
   `codegraph_node`"*, and the rest map to `query` / `callers` / `callees` /
   `impact` / `files` / `status`. Verified live below.

So: `execFile("codegraph", [...])`, parse nothing, relay the model-ready text.
Most of OMO's complexity exists to make an MCP server survive Codex's startup
contract; none of it is load-bearing for us.

**Style anchor:** `extensions/hindsight/index.ts`. Match it exactly —
default-export factory `(pi: ExtensionAPI) => void`, one helper returning
`{ data?, error?, status? }`-shaped results, an `errorResult()` helper, typebox
`Type.Object` parameters, `type: "text" as const` content blocks, env-var
configuration with a sensible default. The one structural difference: the
transport is `child_process.execFile`, not `fetch`.

## CodeGraph CLI contract (verified live on 2026-08-24 against v1.4.1)

Binary found at `~/.omo/codegraph/bin/codegraph` (OMO-provisioned; not on
`PATH` in a plain shell). Nine projects are already indexed under
`~/.codegraph/daemons/`, including `~/Workspace/poise`.

### Commands we wrap

| Command | Options | Output |
| --- | --- | --- |
| `codegraph explore <query...>` | `-p/--path`, `--max-files` | markdown, **no ANSI** |
| `codegraph node [name]` | `-p/--path`, `-f/--file`, `--offset`, `--limit`, `--symbols-only` | markdown, **no ANSI** |
| `codegraph query <search>` | `-p/--path`, `-l/--limit`, `-k/--kind`, `-j/--json` | text, **ANSI-colored** |
| `codegraph callers <symbol>` | `-p/--path`, `-l/--limit`, `-j/--json` | text, **ANSI-colored** |
| `codegraph callees <symbol>` | `-p/--path`, `-l/--limit`, `-j/--json` | text, **ANSI-colored** |
| `codegraph impact <symbol>` | `-p/--path`, `-d/--depth`, `-j/--json` | text, **ANSI-colored** |
| `codegraph files` | `-p/--path`, `--filter`, `--pattern`, `--format`, `--max-depth`, `-j/--json` | text, **ANSI-colored** |
| `codegraph status [path]` | `-j/--json` | text, **ANSI-colored** |

Every command accepts `-p/--path`, so a tool call can target any indexed
project — a monorepo sub-service or a second repo — without changing cwd. This
mirrors the MCP `projectPath` argument.

### Three behaviors that shape the design

**1. `explore` output is already model-ready.** Verified against
`~/Workspace/poise`: markdown with a "Blast radius" section (callers + missing
test coverage per symbol), then verbatim line-numbered source grouped by file,
with an explicit banner telling the model not to re-Read those files. Nothing to
parse or reformat — relay it verbatim.

**2. An unindexed project answers with agent-facing guidance, not a crash.**
Running `codegraph explore foo` in `/tmp` prints to **stderr** and exits **1**:

```
✗ CodeGraph isn't available here — no .codegraph/ index exists in /tmp. If you
are an AI agent: continue with your usual tools; indexing is the user's
decision, do not run it yourself. (The project owner can enable CodeGraph with
'codegraph init'.)
```

The non-zero exit is the CLI's convention for "no answer", not a fault — so the
extension pattern-matches this text and relays it as a **normal** tool result,
the way OMO's `guidance.ts` matches the same strings. Upstream has already
decided the agent must not self-initialize.
**We honor that: no auto-`init`, no session-start bootstrap worker.** This is the
single biggest divergence from OMO, which spawns a detached `codegraph init`
worker with a lock, an exponential cooldown and a JSONL outcome log. That whole
subsystem exists to fight upstream's stated intent; we skip it and let the user
run `codegraph init` themselves.

**3. `NO_COLOR=1` is NOT honored.** Verified — `codegraph query` still emits
`\x1b[36m…` with `NO_COLOR=1` set. The six colored commands must be stripped
client-side. `--json` also works but is far more token-hungry (a 2-result
`query` JSON is ~40 lines vs ~8 lines of text), so: **strip ANSI, keep the
human-readable form.** OMO strips with the same regex
(`packages/utils/src/codegraph/guidance.ts`, `ANSI_ESCAPE_PATTERN`).

## Tool surface — recommendation

CodeGraph's README states a measured result worth respecting:

> When running as an MCP server, CodeGraph exposes a **single tool** —
> `codegraph_explore`. Measured agent behavior showed that one strong tool
> steers agents better than a menu of narrower ones — fewer mis-picks, and it
> saves context every session.

The narrower tools stay functional but unlisted, re-enablable via
`CODEGRAPH_MCP_TOOLS`. Their content already arrives inline on `explore` (blast
radius covers `impact`/`callers`; a symbol's body covers `callees`).

**Recommended default: two tools registered.**

- `codegraph_explore` — the primary. Any "how does X work", "how does X reach
  Y", or "survey this area" question, in one call.
- `codegraph_node` — targeted read of one symbol's source + caller/callee trail,
  or a file with line numbers. Genuinely distinct from `explore` (pinpoint vs.
  survey) and cheap.

The other six ship as code but stay unregistered unless `CODEGRAPH_TOOLS` names
them — the same escape hatch upstream provides, ~10 lines of allowlist parsing.
The OMO `tech-debt-audit` skill leans on `callers`/`impact`/`explore`, so having
them one env var away matters if you port that workflow.

**Alternative, if you'd rather have everything up front:** register all eight
unconditionally and drop the allowlist. Costs roughly 6 extra tool descriptions
of system-prompt budget every session, against upstream's measured finding that
it makes tool choice *worse*. Say the word and the plan drops the gate.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CODEGRAPH_BIN` | (resolved) | absolute path to the `codegraph` binary; overrides resolution |
| `CODEGRAPH_TOOLS` | `explore,node` | comma-separated short names to register (`explore`, `node`, `query`, `callers`, `callees`, `impact`, `files`, `status`) |
| `CODEGRAPH_TIMEOUT_MS` | `120000` | per-call child-process timeout |

`CODEGRAPH_BIN` is the name OMO's resolver already accepts as its legacy env key
(`packages/utils/src/codegraph/resolve.ts`), so an existing OMO setup keeps
working.

**Binary resolution order** (three steps, versus OMO's five — no bundled dist,
no auto-provisioning):

1. `CODEGRAPH_BIN`, if set and the file exists.
2. `codegraph` on `PATH`.
3. `~/.omo/codegraph/bin/codegraph`, if it exists.

Not found → the extension registers nothing and returns. No error, no wasted
prompt budget. Explicitly out of scope: downloading `@colbymchenry/codegraph`,
Node-version gating (OMO gates majors 20–24 because ≥25 crashes CodeGraph
mid-indexing — irrelevant here, the CLI ships its own self-contained runtime).

## Steps

### 1. Create `extensions/codegraph/index.ts` → verify: `bun run check` passes

Single file. Structure, top to bottom:

**Constants**

```ts
const OMO_FALLBACK_BIN = join(homedir(), ".omo", "codegraph", "bin", "codegraph");
const DEFAULT_TOOLS = "explore,node";
const DEFAULT_TIMEOUT_MS = 120000;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
```

**Shared plumbing**

- `resolveBin(): string | null` — the three-step order above, memoized in a
  module-level `let`. Uses `existsSync` for steps 1 and 3; for step 2, a
  `execFileSync("command", ["-v", "codegraph"])`-style lookup guarded in
  try/catch, mirroring how `deriveBankId` in hindsight wraps `execFileSync`.
- `runCodegraph(tool, args, cwd, signal)` — promisified `execFile` with
  `{ cwd, timeout, maxBuffer: 10 * 1024 * 1024, signal, encoding: "utf-8" }`.
  Returns `{ data?: string, error?: string }`. On non-zero exit, surface
  `stderr || stdout` as `error`. On `AbortError`/`ETIMEDOUT`, return a readable
  timeout message naming the tool. `maxBuffer` matters: a broad `explore` on a
  large repo emits a lot of source.
- `stripAnsi(text)` — `text.replace(ANSI_PATTERN, "")`.
- `errorResult(text)` — copy hindsight's verbatim, minus the `status` field
  (there are no HTTP statuses here).
- `pathArgs(params, ctx)` — returns `["-p", params.project_path]` when the
  optional param is set, else `[]`. Every tool routes through it.

**Registration gate** — inside `pi.on("session_start", ...)`, not at factory
top level. `docs/extensions.md:1338` confirms `registerTool` works inside
`session_start` and that new tools refresh immediately in the same session. Two
reasons to gate there rather than at load:

- `ctx.cwd` is only available on the event, and we want to check that *this
  project* is indexed before spending prompt budget.
- Gate condition: `resolveBin() !== null` **and** a `.codegraph/` directory
  exists at `ctx.cwd` or any ancestor (walk up, same way git finds `.git/`;
  `~/Workspace/poise/.codegraph` is a symlink into the OMO store, so use
  `existsSync`, which follows links, not `lstatSync`).
- Guard against double registration on `reason: "reload" | "new" | "resume"`
  with a module-level `registered` boolean.

Not indexed → register nothing. The model then never sees a CodeGraph tool it
can only get a refusal from, and the user's `grep`/`Read` flow is untouched.

**Tool: `codegraph_explore`** (always registered when the gate passes)

- `label: "Explore Code"`.
- Description: answer a question about the codebase in one call — returns the
  relevant symbols' verbatim source grouped by file, the call paths between
  them, and a blast-radius summary. Follows dynamic dispatch (callbacks, React
  re-render, interface→impl) that grep cannot. Naming a file or symbol in the
  query returns its current line-numbered source.
- Parameters:
  - `query`: `Type.String({ minLength: 1 })` — a natural-language question, or a
    bag of symbol names spanning the flow under investigation
    (`"PmsProductController getList PmsProductService list"`). Upstream's
    `buildFlowFromNamedSymbols` explicitly optimizes for that second shape —
    say so in the description, it materially improves results.
  - `max_files`: optional `Type.Integer({ minimum: 1, maximum: 50 })` — cap on
    files to pull source from.
  - `project_path`: optional `Type.String()` — target another indexed project.
- `execute`: `runCodegraph("codegraph_explore", ["explore", params.query, ...maxFilesArgs, ...pathArgs], ctx.cwd, signal)`.
  Relay stdout **verbatim** — no `stripAnsi` (verified clean), no reformatting.
  `details: { query, projectPath }`.

**Tool: `codegraph_node`**

- `label: "Read Symbol"`.
- Description: read one symbol's source plus its caller/callee trail, or read a
  file with line numbers and its dependents. Note the container contract
  explicitly (OMO documents it as the `includeCode` contract): classes,
  interfaces, modules and enums return a **structural outline with a member
  list**, not a body — for a container's code, call `codegraph_node` on a
  specific member, or use file mode. Verified: `codegraph node Photo` returns
  `**Members (2):**` plus `> Structural outline only.`
- Parameters:
  - `name`: `Type.String({ minLength: 1 })` — symbol name, or a file path when
    `file_mode` is set.
  - `file`: optional `Type.String()` — treat `name` as a file, or disambiguate a
    symbol to this file (`-f`).
  - `offset` / `limit`: optional `Type.Integer({ minimum: 1 })` — file mode line
    window.
  - `symbols_only`: optional `Type.Boolean()` — file mode: symbol map +
    dependents only.
  - `project_path`: optional `Type.String()`.
- `execute`: assemble flags, relay stdout verbatim. `details: { name, projectPath }`.

**Tools behind `CODEGRAPH_TOOLS`** — thin, uniform, each ≤15 lines:

| Tool | Command | Parameters beyond `project_path` |
| --- | --- | --- |
| `codegraph_query` | `query <search>` | `search`, `limit?`, `kind?` |
| `codegraph_callers` | `callers <symbol>` | `symbol`, `limit?` |
| `codegraph_callees` | `callees <symbol>` | `symbol`, `limit?` |
| `codegraph_impact` | `impact <symbol>` | `symbol`, `depth?` |
| `codegraph_files` | `files` | `filter?`, `pattern?`, `format?`, `max_depth?` |
| `codegraph_status` | `status` | — |

All six pipe stdout through `stripAnsi` before returning.

**Prompt wiring** (mirror hindsight's one-liners):

- `promptSnippet` on `codegraph_explore`: "codegraph_explore: semantic search
  over the indexed codebase — symbols' source, call paths and blast radius in
  one call."
- `promptGuidelines` on `codegraph_explore`: "Prefer codegraph_explore over a
  grep/Read sweep when you need to understand how something works or what a
  change affects — it returns verbatim source and follows dynamic dispatch grep
  cannot. Do not Read files whose source codegraph_explore already returned."
- `promptGuidelines` on `codegraph_node`: "Use codegraph_node to read one
  symbol's source and its callers instead of Reading the whole file."

### 2. Create `extensions/codegraph/README.md` → verify: covers tools + config + prerequisite

Follow `extensions/hindsight/README.md`'s shape. Must state up front that the
extension is a **thin wrapper over an externally installed `codegraph` CLI** —
it installs nothing, and the tools appear only when the binary resolves *and*
the project has a `.codegraph/` index. Document `codegraph init` as the user's
step, with upstream's rationale for why the agent doesn't do it.

### 3. Update root `README.md` → verify: table row present, wishlist updated

- Add a `codegraph` row to the Plugins table:
  *"Semantic code search and exploration over a local CodeGraph index (requires the `codegraph` CLI)"*.
- Remove the `CodeGraph` bullet from the "New Plugins" wishlist.

## Verification

All must pass before this is done.

1. `bun run check` — typechecks clean.
2. **Binary resolution**, in three shells:
   - `CODEGRAPH_BIN=/nonexistent` → falls through to PATH, then the OMO path.
   - `PATH` without codegraph and no `~/.omo/codegraph/bin` → extension
     registers nothing; pi starts normally and `/tools` lists no `codegraph_*`.
   - `PATH="$HOME/.omo/codegraph/bin:$PATH"` → tools present.
3. **Gate**, in two cwds:
   - From `~/Workspace/poise` (indexed, verified: 119 files / 411 nodes / 472
     edges) → `codegraph_explore` and `codegraph_node` registered.
   - From a fresh `mktemp -d` (no index) → neither registered.
4. **Live parity** — each tool's output must match its CLI equivalent:
   - `codegraph_explore("photo rating")` from `~/Workspace/poise` ≡
     `codegraph explore "photo rating"`. Verified during planning: 17 symbols,
     4 files, blast radius + verbatim Ruby source.
   - `codegraph_node("Photo")` ≡ `codegraph node Photo` — structural outline,
     2 members, caller trail.
   - `CODEGRAPH_TOOLS=explore,node,query,callers` → `codegraph_query("photo")`
     returns **ANSI-free** text. Grep the result for `\x1b` — it must be absent.
     This is the one regression the stripping exists to catch.
5. **Cross-project targeting**: from an unrelated cwd, `codegraph_explore` with
   `project_path: "~/Workspace/poise"` (expanded) returns poise results.
   Verified at CLI level with `-p`.
6. **Unindexed relay**: `project_path` pointing at `/tmp` returns upstream's
   "CodeGraph isn't available here" guidance as a **non-error** result — the
   model should read it and fall back, not treat it as a tool failure. A
   genuinely broken invocation must still come back `isError: true`.
7. **Abort**: cancel a running `codegraph_explore` mid-flight (Esc in pi);
   confirm the child process is killed, not orphaned — `pgrep -f codegraph`
   should show only the daemon.
8. **In-agent test**: re-export from a project's `.pi/extensions/`, run pi in
   `~/Workspace/poise`, ask "how does photo rating work?"; confirm it reaches
   for `codegraph_explore` first rather than grepping.

## Out of scope (intentionally, with reasons)

- **MCP bridging.** pi has no MCP; the CLI is at parity. Skipping OMO's
  `mcp-bridge.ts` / `mcp-unavailable.ts` entirely.
- **Auto-provisioning the binary.** OMO downloads and pins
  `@colbymchenry/codegraph` into `~/.omo/codegraph`. Installing software behind
  the user's back is not this repo's job — resolve or stay silent.
- **Session-start auto-`init`.** Upstream's own error text tells agents not to
  index. OMO's lock + exponential cooldown + JSONL outcome log exists to work
  around that; we don't need the workaround because we don't do the thing.
- **Node-version gating.** OMO gates majors 20–24 because the *provisioned*
  package runs on the host's Node. The CLI binary bundles its own runtime.
- **Daemon/zombie sweeping.** OMO ships four modules for it
  (`process-sweep`, `process-sweeper`, `zombie-sweep`, `worker-process-sweep`).
  CodeGraph's own daemon has ppid watchdogs (`dist/mcp/ppid-watchdog.d.ts`,
  `early-ppid.d.ts`), and we spawn short-lived CLI children, not a long-lived
  bridge. If orphans show up in practice, revisit — don't pre-build it.
- **Project-exclusion lists.** OMO's `excluded_roots` guards a plugin
  auto-enabled everywhere. Our `.codegraph/`-exists gate is already the
  narrower, self-maintaining version of the same idea.
- **Output caching.** Calls hit a warm local daemon; a repeat `explore` on
  `~/Workspace/poise` returned in 0.18s.
- **`codegraph affected` / `sync` / `index` / `daemon`.** Developer and CI
  commands, not agent-facing reads. `sync` in particular mutates the index —
  same reasoning as auto-`init`.

## Open question

Nothing blocking. The one call worth your sign-off before implementation is the
**tool surface** (§ "Tool surface — recommendation"): two tools by default with
six behind `CODEGRAPH_TOOLS`, versus all eight registered unconditionally. The
plan assumes the former.
