# my-pi-agent-plugins

Custom extensions for the [pi coding agent](https://github.com/badlogic/pi-mono), packaged as a single [pi package](https://pi.dev/docs/packages).

## Plugins

| Plugin | Description |
| --- | --- |
| [hindsight](extensions/hindsight/) | Per-project long-term memory backed by a [Hindsight](https://github.com/vectorize-io/hindsight) REST API: auto-retains your prompts and final responses, `hindsight_recall` tool for search |

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
