// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { assertSafeRef, git, gitRoot } from "./changes.js";
import type { CommitProvenance, Provenance } from "./types.js";
import { uniq } from "./util.js";

/**
 * Detect AI-assisted commits in a git range from co-author trailers, tool markers and bot
 * authors. This is evidence the tools leave behind voluntarily, so it under-counts: treat
 * it as a signal for reviewers, not as an audit.
 */
interface Signature {
  tool: string;
  /** Matched against `Co-authored-by:` / `Assisted-by:` / `Generated-by:` trailer values. */
  trailer?: RegExp;
  /** Matched against the whole commit message. */
  message?: RegExp;
  /** Matched against `Name <email>` of the commit author. */
  author?: RegExp;
}

const SIGNATURES: Signature[] = [
  {
    tool: "Claude",
    trailer: /noreply@anthropic\.com|\bclaude\b.*\b(anthropic|opus|sonnet|haiku|fable|mythos|code)\b/i,
    author: /\bclaude\[bot\]/i,
  },
  { tool: "Claude", message: /generated with \[?claude code/i },
  { tool: "GitHub Copilot", trailer: /copilot/i, author: /copilot(-swe-agent)?(\[bot\])?/i },
  { tool: "Cursor", trailer: /\bcursor(agent)?\b|@cursor\.(com|sh)/i, author: /cursor(-agent)?\[bot\]/i },
  { tool: "OpenAI Codex", trailer: /\bcodex\b|@openai\.com/i, author: /chatgpt-codex|codex\[bot\]/i },
  { tool: "Gemini", trailer: /\bgemini\b|\bjules\b/i, author: /google-labs-jules|gemini-code-assist/i },
  { tool: "Devin", trailer: /\bdevin\b/i, author: /devin-ai-integration/i },
  { tool: "Windsurf", trailer: /windsurf|codeium/i },
  { tool: "Aider", trailer: /\baider\b/i, message: /^aider: /im },
  { tool: "Agentforce Vibes", trailer: /agentforce|vibe ?codey/i },
  { tool: "Amazon Q", trailer: /amazon q|codewhisperer/i },
];

const AI_TRAILER = /^(co-authored-by|assisted-by|generated-by|ai-assisted|ai-tool):\s*(.+)$/gim;

export function detectAiTools(message: string, author: string): string[] {
  const tools: string[] = [];
  const trailers = [...message.matchAll(AI_TRAILER)].map((m) => ({ key: m[1]!.toLowerCase(), value: m[2]!.trim() }));
  for (const sig of SIGNATURES) {
    if (sig.trailer && trailers.some((t) => sig.trailer!.test(t.value))) tools.push(sig.tool);
    else if (sig.message?.test(message)) tools.push(sig.tool);
    else if (sig.author?.test(author)) tools.push(sig.tool);
  }
  // Explicit declarations from tools we don't know by name.
  if (!tools.length && trailers.some((t) => t.key !== "co-authored-by" && !/^(no|false)$/i.test(t.value))) {
    tools.push("AI (declared)");
  }
  return uniq(tools);
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * Commits in `base..head` (head defaults to HEAD) that touch the project directory.
 * Returns undefined when the project is not in a git repository or the range is invalid.
 */
export function gitProvenance(projectDir: string, base: string, head?: string): Provenance | undefined {
  try {
    assertSafeRef(base, "base ref");
    if (head) assertSafeRef(head, "head ref");
    const root = gitRoot(projectDir);
    if (!root) return undefined;
    const range = `${base}..${head ?? "HEAD"}`;
    const out = git(root, [
      "log",
      `--format=%H${FIELD}%an <%ae>${FIELD}%s${FIELD}%B${RECORD}`,
      range,
      "--",
      path.resolve(projectDir),
    ]);
    const details: CommitProvenance[] = out
      .split(RECORD)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha = "", author = "", subject = "", body = ""] = r.split(FIELD);
        return { sha: sha.slice(0, 12), subject, author, aiTools: detectAiTools(body, author) };
      });
    const ai = details.filter((d) => d.aiTools.length);
    return {
      range,
      commits: details.length,
      aiAssistedCommits: ai.length,
      tools: uniq(ai.flatMap((d) => d.aiTools)).sort(),
      details,
    };
  } catch {
    return undefined;
  }
}
