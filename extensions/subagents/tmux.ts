import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

// Thin tmux adapter. `exec` is pi.exec injected by the caller so this module can
// be driven from a scratch script against a private tmux server (`tmux -L`).
// Every call is bounded by a 5 s timeout; failures surface as thrown Errors
// carrying tmux's stderr so tool results can show them.

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const WINDOW_NAME = "subagents";
const TIMEOUT = 5000;

export function sessionName(rootSessionId: string): string {
  return "pi-" + rootSessionId.slice(0, 8);
}

/** POSIX single-quote quoting; valid in sh, bash, zsh and fish. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function tmux(exec: Exec, args: string[]): Promise<string> {
  const result = await exec("tmux", args, { timeout: TIMEOUT });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "timed out" : "exit " + result.code);
    throw new Error("tmux " + args[0] + " failed: " + detail);
  }
  return result.stdout.trim();
}

export async function hasSession(exec: Exec, name: string): Promise<boolean> {
  const result = await exec("tmux", ["has-session", "-t", "=" + name], { timeout: TIMEOUT });
  return result.code === 0;
}

export interface SpawnOptions {
  name: string;
  cwd: string;
  env: Record<string, string>;
  /** Shell command line, already quoted (see shellQuote). */
  command: string;
}

/**
 * Run `command` in a new pane of session `name`, creating the session when
 * needed (the first subagent is then the first pane, no idle shell is left).
 * Returns the tmux pane id ("%N").
 */
export async function spawnPane(exec: Exec, options: SpawnOptions): Promise<string> {
  const envArgs = Object.entries(options.env).flatMap(([k, v]) => ["-e", k + "=" + v]);
  const common = ["-c", options.cwd, ...envArgs, "-P", "-F", "#{pane_id}"];
  const target = options.name + ":" + WINDOW_NAME;
  let paneId: string;
  if (!(await hasSession(exec, options.name))) {
    paneId = await tmux(exec, ["new-session", "-d", "-s", options.name, "-n", WINDOW_NAME, ...common, options.command]);
  } else {
    try {
      paneId = await tmux(exec, ["split-window", "-t", target, ...common, options.command]);
    } catch {
      // the window was closed or renamed: start a fresh one with the same name
      paneId = await tmux(exec, ["new-window", "-t", options.name, "-n", WINDOW_NAME, ...common, options.command]);
    }
  }
  await exec("tmux", ["select-layout", "-t", target, "tiled"], { timeout: TIMEOUT });
  return paneId;
}

/** Pane ids currently alive in the session; empty when the session is gone. */
export async function listPanes(exec: Exec, name: string): Promise<Set<string>> {
  const result = await exec("tmux", ["list-panes", "-s", "-t", "=" + name, "-F", "#{pane_id}"], { timeout: TIMEOUT });
  if (result.code !== 0) return new Set();
  return new Set(result.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
}

export async function killPane(exec: Exec, paneId: string): Promise<void> {
  const result = await exec("tmux", ["kill-pane", "-t", paneId], { timeout: TIMEOUT });
  // "can't find pane" / "no server running" mean it is already gone, which is what we want
  if (result.code !== 0 && !/can't find|no such|no server running/i.test(result.stderr)) {
    throw new Error("tmux kill-pane failed: " + (result.stderr.trim() || "exit " + result.code));
  }
}

export async function killSessionIfEmpty(exec: Exec, name: string): Promise<boolean> {
  if (!(await hasSession(exec, name))) return true;
  if ((await listPanes(exec, name)).size > 0) return false;
  await exec("tmux", ["kill-session", "-t", "=" + name], { timeout: TIMEOUT });
  return true;
}
