// SPDX-License-Identifier: Apache-2.0
import type { TestKind } from "../types.js";
import type { TestGenResult } from "./generate.js";

const KIND_LABEL: Record<TestKind, string> = {
  bulk: "bulk",
  recursion: "recursion",
  idempotency: "idempotency",
  "validation-collision": "validation errors surface",
  "permission-negative": "permission",
  boundary: "boundary",
};

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface TestsMarkdownOptions {
  /**
   * The SFDX project directory relative to the current directory. The `sf` CLI has to run inside
   * the project, so the suggested command starts with `cd` when this isn't ".".
   */
  projectDir?: string;
  /** The project's package directories, relative to the project (default: force-app). */
  sourceDirs?: string[];
  /**
   * Where the generated files were written, relative to the project (or absolute when outside it).
   * Leave it out when they were saved inside a package directory.
   */
  outDir?: string;
}

/** Quote a path for a POSIX shell when it needs it. */
const shellArg = (s: string) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** Human summary of generated tests: what was generated, what wasn't and why, how to run them. */
export function testsToMarkdown(gen: TestGenResult, opts: TestsMarkdownOptions = {}): string {
  const out: string[] = [];
  out.push(`## Preflight tests: ${gen.tests.length} generated, ${gen.skipped.length} skipped`, "");
  if (!gen.tests.length) {
    out.push("_Nothing to generate for this change._", "");
  } else {
    out.push(
      `Test class \`${gen.className}\` · data factory \`${gen.factoryName}\` · ${gen.bulkSize} records per bulk test`,
      "",
    );
    out.push("| Test | Kind | Checks | Notes |", "|---|---|---|---|");
    for (const t of gen.tests) {
      out.push(`| \`${t.method}\` | ${KIND_LABEL[t.kind]} | ${esc(t.title)} | ${esc(t.notes.join(" "))} |`);
    }
    out.push("");
  }
  if (gen.skipped.length) {
    out.push("### Not generated", "", "| Kind | Test | Why |", "|---|---|---|");
    for (const s of gen.skipped) out.push(`| ${KIND_LABEL[s.kind]} | ${esc(s.title)} | ${esc(s.reason)} |`);
    out.push("");
  }
  if (gen.tests.length) {
    const dirs = [...(opts.sourceDirs?.length ? opts.sourceDirs : ["force-app"])];
    if (opts.outDir) dirs.push(opts.outDir);
    const cd = opts.projectDir && opts.projectDir !== "." ? [`cd ${shellArg(opts.projectDir)}`] : [];
    out.push(
      "### Run them",
      "",
      "Run them in a sandbox or scratch org together with your change, for example as a check-only deployment that",
      "rolls everything back:",
      "",
      "```bash",
      ...cd,
      `sf project deploy validate ${dirs.map((d) => `--source-dir ${shellArg(d)}`).join(" ")} \\`,
      `  --test-level RunSpecifiedTests --tests ${gen.className} --target-org <sandbox>`,
      "```",
      "",
      "A failing test points at a real risk (governor limits, recursion, double-applied automation, swallowed",
      "errors) or at test data this org rejects; the NOTE comments in the class say which values to adjust.",
    );
  }
  return out.join("\n");
}
