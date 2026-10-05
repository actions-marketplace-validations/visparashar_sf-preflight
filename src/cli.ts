#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import type { AnalysisResult, SaveEvent } from "./core/index.js";
import {
  agentExplanationToMarkdown,
  agentListToMarkdown,
  allAgentActions,
  explainAgent,
  GENERIC_ORG_LABEL,
  loadProject,
  run,
  runTests,
  saveProcedure,
  sourceRoots,
  testsToMarkdown,
  toMarkdown,
  toSarif,
  type ValidationResult,
  validateTests,
  validationToMarkdown,
} from "./core/index.js";

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
  .command("tests")
  .description("Generate Apex tests for what a change touches (bulk, recursion, idempotency, swallowed errors)")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
  .option("--head <ref>", "git head ref (default: working tree)")
  .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
  .option("-o, --out <dir>", "directory to write the classes to (default: <project>/preflight-tests)")
  .option("--prefix <name>", "prefix for generated class names", "Preflight")
  .option("--class-name <name>", "test class name (default: <prefix>ChangeTest)")
  .option("--bulk-size <n>", "records per bulk test", (v) => Number.parseInt(v, 10), 200)
  .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
  .option("--dry-run", "print the summary without writing files")
  .option("--validate", "run the tests in --org with a check-only deployment (nothing is saved)")
  .option("--org <alias>", "org for --validate: a sandbox, scratch org or Developer Edition org")
  .option("--allow-production", "allow --validate in a production org")
  .option("--wait <minutes>", "minutes to wait for --validate", (v) => Number.parseInt(v, 10), 33)
  .addOption(new Option("--format <format>", "summary format").choices(["md", "json"]).default("md"))
  .action(
    (opts: {
      project: string;
      base?: string;
      head?: string;
      files?: string[];
      out?: string;
      prefix: string;
      className?: string;
      bulkSize: number;
      depth: number;
      dryRun?: boolean;
      validate?: boolean;
      org?: string;
      allowProduction?: boolean;
      wait: number;
      format: "md" | "json";
    }) => {
      if (opts.validate && !opts.org) throw new Error("--validate needs --org <alias>.");
      if (opts.validate && opts.dryRun) throw new Error("--validate can't be combined with --dry-run.");
      if (opts.org && !opts.validate) throw new Error("--org is only used with --validate.");
      const { tests } = runTests({
        projectDir: opts.project,
        base: opts.base,
        head: opts.head,
        files: opts.files,
        maxDepth: opts.depth,
        prefix: opts.prefix,
        className: opts.className,
        bulkSize: opts.bulkSize,
      });
      const outDir = path.resolve(opts.out ?? path.join(opts.project, "preflight-tests"));
      if (!opts.dryRun) {
        for (const f of tests.files) {
          const target = path.join(outDir, f.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, f.content);
        }
      }
      const shown = (p: string) => {
        const rel = path.relative(process.cwd(), p);
        return rel === "" ? "." : rel.startsWith("..") ? p : rel;
      };
      const shownDir = shown(outDir);
      const projectAbs = path.resolve(opts.project);
      const sourceDirs = sourceRoots(projectAbs);
      // Paths in the suggested `sf` command are relative to the project, where `sf` has to run.
      const inProject = path.relative(projectAbs, outDir);
      const insideSource = sourceDirs.some((d) => {
        const rel = path.relative(path.resolve(projectAbs, d), outDir);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      });
      const outForSf = insideSource
        ? undefined
        : inProject.startsWith("..") || path.isAbsolute(inProject)
          ? outDir
          : inProject.split(path.sep).join("/");
      if (!opts.dryRun && tests.files.length) {
        process.stderr.write(`Wrote ${tests.files.length} files to ${shownDir}\n`);
      }
      let validation: ValidationResult | undefined;
      if (opts.validate && opts.org && tests.tests.length) {
        process.stderr.write(
          "Running the generated tests with a check-only deployment (nothing is saved); this can take a few minutes...\n",
        );
        validation = validateTests({
          org: opts.org,
          projectDir: projectAbs,
          sourceDirs,
          testsDir: outForSf,
          className: tests.className,
          methods: tests.tests.map((t) => t.method),
          waitMinutes: opts.wait,
          allowProduction: opts.allowProduction,
        });
        if (validation.status === "failed") process.exitCode = 2;
      }
      if (opts.format === "json") {
        const { files, ...rest } = tests;
        const json = {
          ...rest,
          outDir: opts.dryRun ? undefined : shownDir,
          files: files.map((f) => f.path),
          validation,
        };
        process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        const results = validation ? validationToMarkdown(validation) : undefined;
        process.stdout.write(
          `${testsToMarkdown(tests, {
            projectDir: shown(projectAbs),
            sourceDirs,
            outDir: outForSf,
            results,
            targetOrg: validation && validation.org !== GENERIC_ORG_LABEL ? validation.org : undefined,
          })}\n`,
        );
      }
    },
  );

program
  .command("agents")
  .description("List Agentforce agents, or explain what one agent's actions call, save and need")
  .argument("[agent]", "agent API name, e.g. Sales_Agent")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .action((agent: string | undefined, opts: { project: string; depth: number; format: "md" | "json" }) => {
    const model = loadProject(opts.project);
    if (!agent) {
      if (opts.format === "json") {
        const list = [...model.agents.values()].map((a) => ({
          name: a.name,
          label: a.label,
          source: a.source,
          topics: a.topics.map((t) => t.name),
          actions: allAgentActions(model)
            .filter((r) => r.agent === a)
            .map((r) => r.action.name),
          file: a.file,
        }));
        process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      } else {
        process.stdout.write(`${agentListToMarkdown(model)}\n`);
      }
      return;
    }
    const e = explainAgent(model, agent, opts.depth);
    if (!e) {
      const known = [...model.agents.values()].map((a) => a.name).join(", ");
      throw new Error(`No agent named ${agent} in the project${known ? ` (agents: ${known})` : ""}.`);
    }
    process.stdout.write(`${opts.format === "json" ? JSON.stringify(e, null, 2) : agentExplanationToMarkdown(e)}\n`);
  });

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
