#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { Command, Option } from "commander";
import type { AnalysisResult, SaveEvent } from "./core/index.js";
import { loadProject, run, saveProcedure, toMarkdown, toSarif } from "./core/index.js";

// `preflight analyze | head` closes stdout early; exit quietly instead of crashing on EPIPE.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

type Format = "md" | "json" | "sarif";

function render(result: AnalysisResult, format: Format): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (format === "sarif") return JSON.stringify(toSarif(result, { toolVersion: version }), null, 2);
  return toMarkdown(result);
}

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
  .addOption(new Option("--format <format>", "output format").choices(["md", "json", "sarif"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--md-out <file>", "also write a Markdown report to this file")
  .option("--json-out <file>", "also write a JSON report to this file")
  .option("--sarif-out <file>", "also write a SARIF report to this file")
  .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
  .option("--org <alias>", "add read-only context from an org authorized with `sf org login` (beta)")
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
      format: Format;
      out?: string;
      mdOut?: string;
      jsonOut?: string;
      sarifOut?: string;
      depth: number;
      org?: string;
      failOn: string;
    }) => {
      const result = run({
        projectDir: opts.project,
        base: opts.base,
        head: opts.head,
        files: opts.files,
        maxDepth: opts.depth,
        org: opts.org,
      });
      const output = render(result, opts.format);
      if (opts.out) writeFileSync(opts.out, `${output}\n`);
      else process.stdout.write(`${output}\n`);
      if (opts.mdOut) writeFileSync(opts.mdOut, `${render(result, "md")}\n`);
      if (opts.jsonOut) writeFileSync(opts.jsonOut, `${render(result, "json")}\n`);
      if (opts.sarifOut) writeFileSync(opts.sarifOut, `${render(result, "sarif")}\n`);
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

program
  .command("mcp")
  .description("Run an MCP server over stdio so coding agents can call preflight")
  .option("--root <dir>", "directory the server may analyze (tool calls cannot reach outside it)", ".")
  .action(async (opts: { root: string }) => {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer({ root: opts.root, version });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`preflight: ${(err as Error).message}`);
  process.exitCode = 1;
});
