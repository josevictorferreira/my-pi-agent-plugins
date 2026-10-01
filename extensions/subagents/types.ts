import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

// Subagent types: four hard-coded built-ins, each optionally overridden by
// ~/.pi/agent/subagents/<type>.md. Frontmatter keys replace the built-in
// value; the markdown body is appended to the built-in prompt. A file whose
// name is not a built-in type defines a new type. Files are read on every
// launch so edits apply without restarting Pi.

export interface SubagentType {
  name: string;
  description: string;
  prompt: string;
  /** Tool allowlist for `--tools`; undefined = all tools. */
  tools?: string[];
  /** Skill names or paths for `--skill`; undefined = Pi's normal skill discovery. */
  skills?: string[];
  /** "provider/id"; undefined = inherit the launcher's current model. */
  model?: string;
  /** "provider/id" to switch to after the first provider error. */
  fallbackModel?: string;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "codegraph_explore", "codegraph_node", "lsp"];

export const BUILTIN_TYPES: Record<string, SubagentType> = {
  explorer: {
    name: "explorer",
    description: "Fast local code-base recon: relevant files, entry points, data flow, risks",
    tools: READ_ONLY_TOOLS,
    prompt:
      "You are an explorer. Investigate this repository quickly and return a handoff brief that another " +
      "agent can act on without re-reading everything it does not need.\n\n" +
      "Strategy: locate with grep/find (or codegraph when available), read key sections rather than whole " +
      "files, follow imports only as far as the task needs, and note how data flows between the files " +
      "you found.\n\n" +
      "Report format:\n" +
      "## Files\n" +
      "One line per file with exact path and line range and what is there.\n" +
      "## Entry points and data flow\n" +
      "How a request/call enters and moves through the code you found.\n" +
      "## Risks and open questions\n" +
      "Anything surprising, fragile, duplicated or untested that the task should know about.\n\n" +
      "Be precise about paths and line numbers; do not propose or make changes.",
  },
  researcher: {
    name: "researcher",
    description: "Web and documentation research with sources and a research brief",
    tools: ["read", "web_search", "web_fetch", "context7_resolve_library_id", "context7_query_docs"],
    prompt:
      "You are a researcher. Answer the question from current sources: library documentation (context7 " +
      "first for third-party libraries), official docs, changelogs, issues and reputable articles found " +
      "with web_search and read with web_fetch. Prefer primary sources and recent material; note the " +
      "date or version a source applies to.\n\n" +
      "Report format:\n" +
      "## Conclusion\n" +
      "Two to five sentences answering the question directly.\n" +
      "## Findings\n" +
      "Bullets, each with the fact and a [n] source reference.\n" +
      "## Sources\n" +
      "[n] title, URL, and why it is trustworthy.\n\n" +
      "Say plainly when sources disagree or when you could not find an answer.",
  },
  worker: {
    name: "worker",
    description: "Implementation work in the repository",
    prompt:
      "You are a worker. Implement the task in this repository: read what you need, make the minimum " +
      "change that solves it, match the existing style, and verify it with the project's own commands " +
      "(typecheck, tests, build) before reporting.\n\n" +
      "Report format:\n" +
      "## Changed\n" +
      "Each file touched and what changed in it.\n" +
      "## Verified\n" +
      "The commands you ran and their results.\n" +
      "## Left undone\n" +
      "Anything out of scope, blocked, or that needs a decision, with the question to answer.\n\n" +
      "Do not commit unless the task says so.",
  },
  oracle: {
    name: "oracle",
    description: "Second opinion before acting: risks, alternatives, one recommendation",
    tools: READ_ONLY_TOOLS,
    prompt:
      "You are an oracle: a senior engineer giving a second opinion on a decision another agent is about " +
      "to make. Read the relevant code before judging. Be direct and specific; say when the proposal is " +
      "fine as it is.\n\n" +
      "Report format:\n" +
      "## Decision under review\n" +
      "Restate it in your own words so misunderstandings surface.\n" +
      "## Risks\n" +
      "Concrete failure modes, each with where in the code it would bite.\n" +
      "## Alternatives\n" +
      "Simpler or safer options, with their trade-offs.\n" +
      "## Recommendation\n" +
      "One recommendation and the reason.\n\n" +
      "You change nothing in the repository.",
  },
};

export const BASE_PROMPT =
  "You are a {type} subagent launched by another agent, not by a person. Your task is the first user " +
  "message. Work only on that task in this repository. Each time you stop, the whole of your final " +
  "message is delivered verbatim to the launching agent, which has not seen your tool calls, so make it " +
  "self-contained: what you found or did, exact file paths, and anything it must decide. Do not ask for " +
  "clarification unless you are blocked; if you are, end your message with the one question you need " +
  "answered. Follow-up instructions may arrive as new user messages.";

export function overridesDir(): string {
  return join(getAgentDir(), "subagents");
}

function stringList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const list = raw.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readOverride(name: string): Promise<{ frontmatter: Record<string, unknown>; body: string } | undefined> {
  try {
    const text = await readFile(join(overridesDir(), name + ".md"), "utf8");
    const parsed = parseFrontmatter<Record<string, unknown>>(text);
    return { frontmatter: parsed.frontmatter ?? {}, body: parsed.body.trim() };
  } catch {
    return undefined;
  }
}

/** Built-in merged with its override, or a user-defined type. Throws for unknown names. */
export async function resolveType(name: string): Promise<SubagentType> {
  const builtin = BUILTIN_TYPES[name];
  const override = await readOverride(name);
  if (!builtin && !override) {
    throw new Error("unknown subagent type \"" + name + "\"; known: " + Object.keys(BUILTIN_TYPES).join(", ") +
      " (user types live in " + overridesDir() + "/<type>.md)");
  }
  const fm = override?.frontmatter ?? {};
  if (!builtin) {
    const description = stringOr(fm.description);
    if (!description) throw new Error("user type \"" + name + "\" needs a `description` in its frontmatter");
    if (!override!.body) throw new Error("user type \"" + name + "\" needs a prompt body");
  }
  const type: SubagentType = {
    name,
    description: stringOr(fm.description) ?? builtin?.description ?? "",
    prompt: [builtin?.prompt, override?.body].filter(Boolean).join("\n\n"),
    tools: stringList(fm.tools) ?? builtin?.tools,
    skills: stringList(fm.skills) ?? builtin?.skills,
    model: stringOr(fm.model) ?? builtin?.model,
    fallbackModel: stringOr(fm.fallbackModel) ?? builtin?.fallbackModel,
  };
  return type;
}

export function buildSystemPrompt(type: SubagentType): string {
  return BASE_PROMPT.replace("{type}", type.name) + "\n\n" + type.prompt + "\n";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Skill entries → existing paths for `--skill`. Names are looked up in the user and project skill dirs; otherwise the entry is a path. */
export async function resolveSkills(entries: string[] | undefined, cwd: string): Promise<string[] | undefined> {
  if (!entries) return undefined;
  const paths: string[] = [];
  for (const entry of entries) {
    const candidates = entry.includes("/") || isAbsolute(entry)
      ? [resolve(cwd, entry)]
      : [join(getAgentDir(), "skills", entry), join(cwd, ".pi", "skills", entry)];
    let found: string | undefined;
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) throw new Error("unknown skill \"" + entry + "\"; looked in " + candidates.join(", "));
    paths.push(found);
  }
  return paths;
}
