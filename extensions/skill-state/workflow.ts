import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const MAX_SPEC_BYTES = 4 * 1024;

// Built-in software-engineering skill (plan §5.7). Kept under 4 KB. The two
// rules the SKILL.state mechanism depends on are "record facts before moving
// on" and "prefer facts over re-reading" (paper §7, failure condition 2).
export const BUILTIN_SPEC = `You are a software engineer completing the objective on a local repository. You only see the current state and the latest observation; anything you did not write into facts is gone.

You have a step budget (current step and maximum are shown with every observation). Phases, in status:
1. inspecting: find where the change starts with search_files (identifiers, not prose; add a glob in large repos) and read_file. The files you read most recently stay open in every prompt. Exit as soon as facts name the files to change and what they do today.
2. planning: write plan as ordered items "path: change" plus the check that proves each. Two steps at most; open questions go to hypotheses.
3. editing: apply one plan item per step with patch_file (small, exactly unique oldText copied from the open file's text) or write_file. Never re-read an open file; read a file only when it is not open. Remove plan items as you finish them.
4. testing: run the project's real checks with exec_shell. Exit when the relevant checks pass.
5. repairing: on a failing check, record the failure in facts, fix, go back to testing. After three failures on the same check, stop and finish.
Then finish: outcome completed only when a check you ran proves the objective; otherwise cannot_complete with a summary of what changed and what remains.

State discipline:
- facts is your memory: paths, symbols, line ranges, signatures, error messages, behaviours; one idea per key; delete stale keys.
- Prefer facts over re-reading; re-read only for exact text to patch.
- blockers are obstacles outside your control (missing credentials, a decision only the user can make, information no action can obtain). The step budget is not a blocker: when it runs low, keep the remaining work in plan and say so in the finish summary.
- Something the objective asks you to add and that does not exist yet is the work, not a blocker: choose a reasonable design, record it as a fact, implement it.

Actions:
- One per step. exec_shell is for read-only commands and test runs, never for editing. Never leave the repository, never run destructive git commands, never install software.
`;

export const MAX_OBJECTIVE_FILE_BYTES = 6 * 1024;

/**
 * Inline `@path` references in the objective, the way Pi inlines `@file` in a
 * prompt. The objective is runtime-owned state and in every prompt, so the task
 * text stays in view for the whole run; without this a run read `PROMPT.md`
 * every other step to remember the task, and another lost the "run the whole
 * suite" instruction once two other files had pushed it out of the open-file
 * window. Files that do not exist or exceed the cap are left as written.
 */
export async function expandObjective(objective: string, cwd: string): Promise<string> {
  const refs = [...new Set(objective.match(/(?<=^|\s)@[\w./-]+/g) ?? [])];
  const sections: string[] = [];
  let budget = MAX_OBJECTIVE_FILE_BYTES;
  for (const ref of refs) {
    const path = ref.slice(1);
    let text: string;
    try {
      text = await readFile(resolve(cwd, path), "utf8");
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(text);
    if (bytes > budget) continue;
    budget -= bytes;
    sections.push("Contents of " + path + ":\n" + text.trim());
  }
  return sections.length ? objective + "\n\n" + sections.join("\n\n") : objective;
}

/** Load a `--skill` markdown file (≤ 4 KB) to use verbatim as the spec. */
export async function loadSpec(skillPath: string | undefined, cwd: string): Promise<string> {
  if (!skillPath) return BUILTIN_SPEC;
  const path = isAbsolute(skillPath) ? skillPath : resolve(cwd, skillPath);
  const text = await readFile(path, "utf8");
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_SPEC_BYTES) {
    throw new Error("skill file is " + bytes + " bytes, limit " + MAX_SPEC_BYTES + ": " + path);
  }
  if (!text.trim()) throw new Error("skill file is empty: " + path);
  return text;
}
