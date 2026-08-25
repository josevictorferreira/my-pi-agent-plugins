---
name: "pi-agent-extensions"
description: "Create, modify, debug, and review Pi coding-agent extensions written in TypeScript. Use when building custom Pi tools, commands, shortcuts, flags, lifecycle hooks, provider integrations, session persistence, dynamic tools, or TUI components; when deciding which extension event or API to use; or when testing and packaging an extension."
---

# Create Pi agent extensions

Build the smallest extension that satisfies the requested behavior. Treat extensions as trusted, full-permission TypeScript modules: review every subprocess, filesystem, network, and user-input boundary before enabling it.

## Workflow

1. Inspect the repository's `AGENTS.md`, `package.json`, existing extensions, and local Pi conventions.
2. Define the behavior and choose the narrowest API:
   - **Tool**: an LLM-callable operation.
   - **Command**: a user-invoked `/name` operation or setup flow.
   - **Event hook**: observe, transform, block, or augment Pi behavior.
   - **Shortcut/flag**: keyboard or CLI configuration.
   - **Provider**: a model endpoint or authentication integration.
   - **TUI API**: interactive dialogs, widgets, renderers, or custom components.
3. Decide the extension scope and layout:
   - One file for a small extension.
   - A directory with `index.ts` for multiple modules.
   - A package-local `package.json` only when third-party dependencies are necessary.
4. Implement a default-exported factory receiving `ExtensionAPI`.
5. Keep session-scoped resources lazy. Start watchers, subprocesses, sockets, and timers from `session_start` or the operation that needs them, not from the factory. Clean them up idempotently from `session_shutdown`.
6. Test directly with `pi -e ./path/to/extension.ts` (or `--extension`). Use an auto-discovered location only after the one-off behavior works; `/reload` applies to auto-discovered extensions.
7. Type-check and inspect the diff. Test the relevant TUI, RPC, print, and cancellation paths when the extension uses them.

## Minimal extension shape

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Pi loads extensions through jiti, so TypeScript normally needs no compilation. The standard imports are:

- `@earendil-works/pi-coding-agent`: `ExtensionAPI`, contexts, event helpers, built-in tool factories, truncation helpers, and `CONFIG_DIR_NAME`.
- `typebox`: tool parameter schemas via `Type`.
- `@earendil-works/pi-ai`: `StringEnum` and provider APIs.
- `@earendil-works/pi-tui`: TUI components and types.
- Node built-ins such as `node:fs/promises`, `node:path`, and `node:child_process`.

## Choose event hooks deliberately

Use the event that owns the behavior rather than a broad hook:

| Need | API |
| --- | --- |
| Decide project trust before project-local resources load | `project_trust` (global/user/CLI extensions only) |
| Add skill, prompt, or theme directories | `resources_discover` |
| Initialize or restore session state | `session_start` |
| Release session resources | `session_shutdown` |
| Add prompt context or alter the current system prompt | `before_agent_start` |
| Transform or handle raw user input | `input` |
| Modify messages before an LLM call | `context` |
| Inspect or mutate provider request headers/payload | `before_provider_headers`, `before_provider_request` |
| Observe provider status/headers | `after_provider_response` |
| Block or patch a tool call before execution | `tool_call` |
| Modify a completed tool result | `tool_result` |
| Observe tool progress | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` |
| React to model or thinking-level changes | `model_select`, `thinking_level_select` |
| Customize compaction or tree summaries | `session_before_compact`, `session_before_tree` |
| Know the whole run has settled | `agent_settled` rather than only `agent_end` |
| Replace user `!`/`!!` shell execution | `user_bash` |

Event handlers receive an `ExtensionContext`. Use `ctx.signal` for nested abort-aware work during active turns, `ctx.cwd` for the current directory, and `ctx.isProjectTrusted()` before honoring trusted project configuration. Do not assume sibling tool results are already in the session during parallel tool preflight.

`tool_call` can return `{ block: true, reason }`; its input is mutable and mutations affect the actual call. `tool_result` handlers act as chained middleware and may return partial result patches. Throw from a tool's `execute` function to report an execution error; returning an error-shaped value does not set `isError`.

## Register custom tools safely

Use a strict TypeBox schema, a concise model-facing description, and the exact Pi tool result shape:

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const schema = Type.Object({
  action: StringEnum(["list", "add"] as const),
  text: Type.Optional(Type.String()),
});

type Input = import("typebox").Static<typeof schema>;

pi.registerTool({
  name: "todo",
  label: "Todo",
  description: "List or add items in the project todo list",
  promptSnippet: "List or add todo items",
  promptGuidelines: ["Use todo when the user asks to manage the project todo list."],
  parameters: schema,
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], details: {} };
    }

    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return {
      content: [{ type: "text", text: `Action: ${params.action}` }],
      details: { action: params.action },
    };
  },
});
```

Rules:

- Use `StringEnum` from `@earendil-works/pi-ai` for string enums; `Type.Union`/`Type.Literal` can fail with Google's API.
- Export the input type when another hook needs typed `isToolCallEventType` narrowing.
- Check cancellation and pass `signal` to `fetch`, model calls, and process helpers.
- Stream meaningful progress through `onUpdate`; keep the final result concise.
- Truncate large output with `truncateHead` or `truncateTail` using Pi's default limits (50 KB or 2,000 lines), and tell the model where complete output was saved if applicable.
- Return small JSON-serializable `details` for rendering and state reconstruction. Return `usage` when the tool performs nested LLM work.
- Add `promptSnippet` only for a useful one-line entry in the system prompt. Every `promptGuidelines` item must name the tool explicitly.
- Use `prepareArguments` only as a compatibility shim for old persisted calls; keep the current public schema strict.
- If the tool mutates a file, resolve the target to an absolute path and wrap the entire read-modify-write window in `withFileMutationQueue()` so parallel calls cannot overwrite one another.
- Return `terminate: true` only when this tool result should end the current tool batch and the operation is genuinely final.

For dynamic tools, register every tool up front, leave searchable tools inactive, keep a loader active, and call `pi.setActiveTools([...current, ...added])` with an additive set. Do not invent provider-specific deferred-tool payloads.

## Commands, input, and messages

Register commands with a short description and optional argument completion. Command contexts add session-control methods such as `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, and `reload`.

After session replacement, use only the fresh context passed to `withSession`; captured old `pi`, `ctx`, or `SessionManager` objects are stale. Treat `await ctx.reload()` as terminal for the command handler: return immediately afterward.

Use `pi.sendMessage()` for extension-owned context that should enter the LLM conversation. Use `pi.sendUserMessage()` when it should appear as an actual user prompt and trigger a turn. While streaming, specify `deliverAs: "steer"` or `"followUp"`. Use `pi.appendEntry()` for durable extension data that must not enter LLM context; pair it with `registerEntryRenderer()` when it needs TUI-only display.

Use `input` results intentionally:

- `{ action: "continue" }` passes through.
- `{ action: "transform", text, images? }` rewrites input before skill/template expansion.
- `{ action: "handled" }` prevents the agent from running.

Do not transform extension-injected messages accidentally; check `event.source` when appropriate.

## State and sessions

Prefer state that can be rebuilt from the active branch. For stateful tools, put the latest snapshot in tool-result `details`, then reconstruct it from `ctx.sessionManager.getBranch()` during `session_start`. This preserves branching behavior better than an in-memory singleton.

Use `ctx.sessionManager` as read-only session state. Useful methods include `getEntries()`, `getBranch()`, `buildContextEntries()`, `getLeafId()`, and `getSessionFile()`.

Use `session_before_switch`, `session_before_fork`, and `session_before_tree` to cancel or customize transitions. Clean up resources in `session_shutdown` for quit, reload, new, resume, and fork paths.

For compaction, return a custom summary only from `session_before_compact` when there is a concrete reason to replace Pi's default behavior. Preserve `preparation.firstKeptEntryId` and `preparation.tokensBefore`; include summary `usage` when generated by an LLM. Use `ctx.compact()` to request compaction rather than manipulating session files directly.

## UI and execution modes

Use `ctx.hasUI` before dialogs and notifications. Use `ctx.mode === "tui"` before terminal-only APIs such as `ctx.ui.custom()`, custom component factories, terminal input, and direct rendering. RPC supports UI through its protocol but `custom()` and some TUI-only features are unavailable; JSON and print modes have no interactive UI.

For simple interaction use `ctx.ui.select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setEditorText`, and `setTitle`. For complex interaction use `ctx.ui.custom()` and a `Component` that renders lines no wider than the terminal width, handles input, and invalidates cached output. Use the injected `keybindings` manager and `keyHint()` rather than hard-coding user-visible key names.

When replacing the editor, extend `CustomEditor`, call `super.handleInput()` for keys not handled by the extension, and capture/wrap the existing editor when composing with other extensions. Restore it with `setEditorComponent(undefined)`.

Use `registerMessageRenderer` for custom messages that participate in model context. Use `registerEntryRenderer` for TUI-only entries. Keep default renderers compact and support `expanded`/`isPartial` when rendering tool output.

## Trust, paths, and packages

Project-local extensions in `.pi/extensions/` load only after the project is trusted. Global extensions belong in `~/.pi/agent/extensions/`; CLI `-e`/`--extension` is best for quick tests. A directory extension uses `index.ts`. Do not assume `.pi` is the config directory when constructing project paths; import and use `CONFIG_DIR_NAME`.

For a distributable package, declare resources under the `pi` key in `package.json`, for example:

```json
{
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
}
```

Put runtime third-party modules in `dependencies`. Core Pi modules should be peer dependencies when publishing a package, not bundled copies. Review source before installing any package: extensions and skills run with full system permissions.

## Verification checklist

- Confirm the default export is a synchronous or awaited async `ExtensionAPI` factory.
- Confirm event names, return values, tool schemas, and result `details` match the installed Pi types/docs.
- Run `pi -e ./extension.ts` in a safe fixture project; exercise success, cancellation, errors, reload, and shutdown.
- Exercise non-TUI modes if the extension uses UI or output formatting.
- Test parallel tool calls when shared state or files are involved.
- Run the repository's type-check command (typically `bun run check` or `tsc --noEmit`).
- Inspect `git diff` and ensure no credentials, tokens, generated `node_modules`, or unrelated refactors were added.

When the API is uncertain or Pi has changed, consult the current extension documentation first: https://pi.dev/docs/latest/extensions. For custom TUI, packages, sessions, compaction, RPC, providers, and keybindings, follow the linked Pi documentation rather than guessing.
