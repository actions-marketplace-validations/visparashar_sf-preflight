import path from "node:path";
import { analyze } from "./analyze.js";
import { filesFromArgs, gitChangedFiles, gitShow, toChanges } from "./changes.js";
import { loadProject } from "./project.js";
import type { AnalysisResult } from "./types.js";

export * from "./types.js";
export { loadProject, classifyPath, sourceRoots } from "./project.js";
export { analyze, fieldReferences } from "./analyze.js";
export { saveProcedure } from "./orderOfExecution.js";
export { gitChangedFiles, toChanges, filesFromArgs } from "./changes.js";
export { toMarkdown } from "./report/markdown.js";

export interface RunOptions {
  projectDir: string;
  /** Git base ref. Required unless `files` is given. */
  base?: string;
  /** Git head ref; defaults to the working tree. */
  head?: string;
  /** Explicit changed files (absolute, cwd-relative or project-relative). */
  files?: string[];
  maxDepth?: number;
}

/** Load the project, work out what changed, and analyze it. */
export function run(opts: RunOptions): AnalysisResult {
  const projectDir = path.resolve(opts.projectDir);
  const model = loadProject(projectDir);
  let changedFiles;
  if (opts.files?.length) {
    changedFiles = filesFromArgs(projectDir, opts.files);
  } else if (opts.base) {
    changedFiles = gitChangedFiles({ projectDir, base: opts.base, head: opts.head });
  } else {
    throw new Error("Provide either --base <git ref> or --files <paths...>");
  }
  const { changes, ignored } = toChanges(changedFiles);
  return analyze({
    model,
    changes,
    ignoredFiles: ignored,
    base: opts.base,
    head: opts.head,
    maxDepth: opts.maxDepth,
    readBase: opts.base ? (file) => gitShow(projectDir, opts.base!, file) : undefined,
  });
}
