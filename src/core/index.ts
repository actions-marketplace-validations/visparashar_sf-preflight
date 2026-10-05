// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { analyze } from "./analyze.js";
import { filesFromArgs, gitChangedFiles, gitRoot, gitShow, toChanges } from "./changes.js";
import { enrichWithOrg } from "./org/enrich.js";
import type { SfRunner } from "./org/sf.js";
import { loadProject } from "./project.js";
import { gitProvenance } from "./provenance.js";
import type { AnalysisResult, ChangeType } from "./types.js";
import { toPosix } from "./util.js";

export { analyze, fieldReferences } from "./analyze.js";
export { assertSafeRef, filesFromArgs, gitChangedFiles, gitRoot, toChanges } from "./changes.js";
export { saveProcedure } from "./orderOfExecution.js";
export { applyOrgContext, collectOrgContext, enrichWithOrg } from "./org/enrich.js";
export { assertSafeOrg, createSfRunner, type SfRunner } from "./org/sf.js";
export { classifyPath, loadProject, sourceRoots } from "./project.js";
export { detectAiTools, gitProvenance } from "./provenance.js";
export { toMarkdown } from "./report/markdown.js";
export { toSarif } from "./report/sarif.js";
export { RULES, ruleInfo } from "./rules.js";
export * from "./types.js";

export interface RunOptions {
  projectDir: string;
  /** Git base ref. Required unless `files` is given. */
  base?: string;
  /** Git head ref; defaults to the working tree. */
  head?: string;
  /** Explicit changed files (absolute, cwd-relative or project-relative). */
  files?: string[];
  maxDepth?: number;
  /** Org alias or username already authorized with `sf org login`: adds read-only org context. */
  org?: string;
  /** Override how `sf` is invoked (tests). */
  sfRunner?: SfRunner;
}

/** Load the project, work out what changed, and analyze it. */
export function run(opts: RunOptions): AnalysisResult {
  const projectDir = path.resolve(opts.projectDir);
  const model = loadProject(projectDir);
  let changedFiles: { file: string; changeType: ChangeType; previousFile?: string }[];
  if (opts.files?.length) {
    changedFiles = filesFromArgs(projectDir, opts.files);
  } else if (opts.base) {
    changedFiles = gitChangedFiles({ projectDir, base: opts.base, head: opts.head });
  } else {
    throw new Error("Provide either --base <git ref> or --files <paths...>");
  }
  const { changes, ignored } = toChanges(changedFiles);
  const root = gitRoot(projectDir);
  const result = analyze({
    model,
    changes,
    ignoredFiles: ignored,
    base: opts.base,
    head: opts.head,
    maxDepth: opts.maxDepth,
    readBase: opts.base ? (file) => gitShow(projectDir, opts.base!, file) : undefined,
    provenance: opts.base && !opts.files?.length ? gitProvenance(projectDir, opts.base, opts.head) : undefined,
  });
  if (root) result.projectPathInRepo = toPosix(path.relative(root, projectDir));
  if (opts.org) enrichWithOrg(model, result, { org: opts.org, runner: opts.sfRunner });
  return result;
}
