# my-pi-agent-plugins

Custom extensions for the [pi coding agent](https://github.com/badlogic/pi-mono), packaged as a single [pi package](https://pi.dev/docs/packages).

## Plugins

| Plugin | Description |
| --- | --- |
| [codegraph](extensions/codegraph/) | Semantic code search and exploration over a local [CodeGraph](https://github.com/colbymchenry/codegraph) index: `codegraph_explore` returns symbols' source, call paths and blast radius in one call (requires the `codegraph` CLI) |
| [hindsight](extensions/hindsight/) | Per-project long-term memory backed by a [Hindsight](https://github.com/vectorize-io/hindsight) REST API: auto-retains your prompts and final responses, `hindsight_recall` tool for search |
| [context7](extensions/context7/) | Up-to-date library documentation from [Context7](https://context7.com): `context7_resolve_library_id` to find a library, `context7_query_docs` to fetch current docs and code examples |
| [web-tools](extensions/web-tools/) | Web search and URL content extraction via the [Velox](https://velox.josevictor.me/docs) proxy: `web_search` and `web_fetch` tools |
| [lsp](extensions/lsp/) | Language server integration: compiler errors appended to `edit`/`write` results, plus an `lsp` tool for hover, definitions, references, symbols and diagnostics |


## New Plugins

These are the plugins that I plan to add as tools for my pi agent. 
- Hindsight (Per-project long-term memory backed by a Hindsight REST API)

## Install

With pi directly (installs every plugin in this repo):

```sh
pi install git:github.com/josevictorferreira/my-pi-agent-plugins
```

Or per-plugin via Nix: add this repo as a flake input and materialize
`extensions/<plugin>/` directories into `~/.pi/agent/extensions/`, which pi
auto-loads (`extensions/*/index.ts`).

## Development

Extensions are loaded by pi through jiti — TypeScript runs directly, no build
step. Typechecking only:

```sh
bun install
bun run check
```

To try a plugin live, run pi from a project containing a `.pi/extensions/`
entry that re-exports it, e.g.:

```ts
export { default } from "~/Workspace/my-pi-agent-plugins/extensions/hindsight/index.ts";
```

## Conventions

- One directory per plugin under `extensions/`, entry point `index.ts` with a
  default-export factory `(pi: ExtensionAPI) => void`.
- Runtime imports must resolve from pi's own dependency tree
  (`@earendil-works/pi-coding-agent`, `typebox`) or node builtins — plugins
  here ship no `node_modules`.
- Each plugin has its own `README.md` documenting tools and configuration.
