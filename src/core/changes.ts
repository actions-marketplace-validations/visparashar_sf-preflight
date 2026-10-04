// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import path from "node:path";
import { classifyPath } from "./project.js";
import type { Change, ChangeType } from "./types.js";
import { toPosix, uniqBy } from "./util.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export interface GitDiffOptions {
  projectDir: string;
  base: string;
  /** Head ref. When omitted, compares base against the working tree (including untracked files). */
  head?: string;
}

const STATUS: Record<string, ChangeType> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

/** Changed files between two refs, restricted to the project directory, as project-relative paths. */
export function gitChangedFiles(
  opts: GitDiffOptions,
): { file: string; changeType: ChangeType; previousFile?: string }[] {
  const projectDir = path.resolve(opts.projectDir);
  const repoRoot = git(projectDir, ["rev-parse", "--show-toplevel"]).trim();
  const range = opts.head ? [`${opts.base}...${opts.head}`] : [opts.base];
  const out = git(repoRoot, ["diff", "--name-status", "-M", ...range, "--", projectDir]);

  const toProjectRel = (repoRel: string) => toPosix(path.relative(projectDir, path.join(repoRoot, repoRel)));
  const results: { file: string; changeType: ChangeType; previousFile?: string }[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const code = cols[0]![0]!;
    const changeType = STATUS[code] ?? "modified";
    if (changeType === "renamed" && cols.length >= 3) {
      results.push({ file: toProjectRel(cols[2]!), changeType, previousFile: toProjectRel(cols[1]!) });
    } else if (cols[1]) {
      results.push({ file: toProjectRel(cols[1]), changeType });
    }
  }
  if (!opts.head) {
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", projectDir]);
    for (const f of untracked.split("\n")) {
      if (f.trim()) results.push({ file: toProjectRel(f.trim()), changeType: "added" });
    }
  }
  return results.filter((r) => !r.file.startsWith(".."));
}

/** Read a file's content at a git ref (used to diff permission sets against the base). */
export function gitShow(projectDir: string, ref: string, projectRelFile: string): string | undefined {
  try {
    const abs = path.resolve(projectDir, projectRelFile);
    const repoRoot = git(path.resolve(projectDir), ["rev-parse", "--show-toplevel"]).trim();
    const repoRel = toPosix(path.relative(repoRoot, abs));
    return execFileSync("git", ["show", `${ref}:${repoRel}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * Turn changed files into component changes. Companion files (`Foo.cls` + `Foo.cls-meta.xml`)
 * collapse into one change.
 */
export function toChanges(files: { file: string; changeType: ChangeType; previousFile?: string }[]): {
  changes: Change[];
  ignored: string[];
} {
  const changes: Change[] = [];
  const ignored: string[] = [];
  for (const f of files) {
    const component = classifyPath(f.file);
    if (component.type === "Other") {
      ignored.push(f.file);
      continue;
    }
    changes.push({ changeType: f.changeType, component, previousFile: f.previousFile });
  }
  return {
    changes: uniqBy(changes, (c) => `${c.component.type}|${c.component.name.toLowerCase()}`),
    ignored,
  };
}

/** Normalise user-supplied file paths (absolute or relative to cwd) to project-relative paths. */
export function filesFromArgs(projectDir: string, files: string[]): { file: string; changeType: ChangeType }[] {
  const root = path.resolve(projectDir);
  return files.map((f) => {
    const abs = path.resolve(f);
    const rel = abs.startsWith(root) ? path.relative(root, abs) : f;
    return { file: toPosix(rel), changeType: "modified" as ChangeType };
  });
}
