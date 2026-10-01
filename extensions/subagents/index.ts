import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChild } from "./child";

// Subagents: delegate work to separate interactive `pi` processes in tmux
// panes. Every Pi process gets the launcher role (tools + /subagents); a
// process started by subagent_launch additionally gets the child role, which
// reports its turns back through the shared task files. See README.md.

export default function (pi: ExtensionAPI) {
  const taskId = process.env.PI_SUBAGENT_TASK;
  const rootSessionId = process.env.PI_SUBAGENT_ROOT;
  if (taskId && rootSessionId) registerChild(pi, taskId, rootSessionId);
}
