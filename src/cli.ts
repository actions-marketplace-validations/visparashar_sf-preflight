#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { Command, Option } from "commander";
import type { SaveEvent } from "./core/index.js";
import { loadProject, run, saveProcedure, toMarkdown } from "./core/index.js";

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const program = new Command();
program
  .name("preflight")
  .description("Preflight checks for Salesforce changes: what will this change set off?")
  .version(version);

program
  .command("analyze")
  .description("Analyze a change (git diff or explicit files) in an SFDX project")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
  .option("--head <ref>", "git head ref (default: working tree)")
  .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--depth <n>", "max cascade depth", (v) => parseInt(v, 10), 4)
  .addOption(
    new Option("--fail-on <level>", "exit with code 2 when risk is at or above this level")
      .choices(["low", "medium", "high", "none"])
      .default("none"),
  )
  .action(
    (opts: {
      project: string;
      base?: string;
      head?: string;
      files?: string[];
      format: "md" | "json";
      out?: string;
      depth: number;
      failOn: string;
    }) => {
      const result = run({
        projectDir: opts.project,
        base: opts.base,
        head: opts.head,
        files: opts.files,
        maxDepth: opts.depth,
      });
      const output = opts.format === "json" ? JSON.stringify(result, null, 2) : toMarkdown(result);
      if (opts.out) writeFileSync(opts.out, `${output}\n`);
      else process.stdout.write(`${output}\n`);
      if (
        opts.failOn !== "none" &&
        RISK_RANK[result.summary.risk] >= RISK_RANK[opts.failOn as keyof typeof RISK_RANK]
      ) {
        process.exitCode = 2;
      }
    },
  );

program
  .command("explain")
  .description("Show what runs, in order, when records of an object are saved")
  .argument("<object>", "object API name, e.g. Opportunity")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .addOption(
    new Option("-e, --event <event>", "DML event")
      .choices(["insert", "update", "delete", "undelete"])
      .default("update"),
  )
  .action((object: string, opts: { project: string; event: SaveEvent }) => {
    const model = loadProject(opts.project);
    const proc = saveProcedure(model, object, opts.event);
    if (!proc.steps.length) {
      console.log(`No modelled automation runs on ${object} ${opts.event}.`);
      return;
    }
    console.log(`${object} — ${opts.event}`);
    for (const s of proc.steps) {
      const writes = s.writes.length ? ` → writes ${s.writes.map((w) => `${w.object} (${w.op})`).join(", ")}` : "";
      const notes = s.notes.length ? `  [${s.notes.join("; ")}]` : "";
      console.log(`  ${s.order}. ${s.phaseLabel.padEnd(18)} ${s.automation.name}${writes}${notes}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`preflight: ${(err as Error).message}`);
  process.exitCode = 1;
});
