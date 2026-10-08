// SPDX-License-Identifier: Apache-2.0
import { cpSync, existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sf-preflight agent skill (Agent Skills format, https://agentskills.io) ships in the npm
 * package. `installSkill` copies it to where agents look for skills:
 *
 * - `.agents/skills/`: Codex, GitHub Copilot and VS Code, Cursor, Gemini CLI and other tools
 *   that follow the shared location;
 * - `.claude/skills/`: Claude Code (also read by VS Code and Cursor).
 */

export const SKILL_NAME = "sf-preflight";

/** The skill folder inside the installed package (or the repository, when run from source). */
export function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "..", "..", "skills", SKILL_NAME),
    path.join(here, "..", "skills", SKILL_NAME),
  ]) {
    if (existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error("The sf-preflight skill isn't in this installation.");
}

export interface InstallSkillOptions {
  /** Project to install into (default: the current directory). Ignored with `global` or `dirs`. */
  projectDir?: string;
  /** Install for the user (home directory) instead of the project. */
  global?: boolean;
  /** Skills directories to install into instead of the defaults. */
  dirs?: string[];
  /** Replace an existing copy. */
  force?: boolean;
  /** The skill folder to copy (default: the one in this package). */
  source?: string;
}

/** Skills directories agents read: the shared `.agents/skills` and Claude's `.claude/skills`. */
export function defaultSkillDirs(base: string): string[] {
  return [path.join(base, ".agents", "skills"), path.join(base, ".claude", "skills")];
}

/** Copy the skill into each skills directory; returns the folders written. */
export function installSkill(opts: InstallSkillOptions = {}): string[] {
  const source = opts.source ?? bundledSkillDir();
  const dirs = opts.dirs?.length
    ? opts.dirs.map((d) => path.resolve(d))
    : defaultSkillDirs(opts.global ? os.homedir() : path.resolve(opts.projectDir ?? "."));
  const targets = dirs.map((d) => path.join(d, SKILL_NAME));
  const existing = targets.filter((t) => existsSync(t));
  if (existing.length && !opts.force) {
    throw new Error(`Already installed in ${existing.join(", ")}. Pass --force to update it.`);
  }
  if (!opts.dirs?.length) {
    // A symbolic link in the way (a committed .claude or .agents link) could redirect the copy,
    // and the removal before it, outside the project.
    const base = opts.global ? os.homedir() : path.resolve(opts.projectDir ?? ".");
    for (const target of targets) assertNoLinkBetween(base, target);
  }
  for (const target of targets) {
    if (path.resolve(target) === path.resolve(source)) continue;
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }
  return targets;
}

/** Refuse when any folder from `base` (exclusive) down to `target` is a symbolic link. */
function assertNoLinkBetween(base: string, target: string): void {
  const rel = path.relative(base, target);
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return; // doesn't exist yet: nothing further down exists either
    }
    if (isLink) {
      throw new Error(`${current} is a symbolic link (to ${realpathSync(current)}); refusing to install through it.`);
    }
  }
}
