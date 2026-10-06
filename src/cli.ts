#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import type { AnalysisResult, FailOn, SaveEvent, TestsResultFile } from "./core/index.js";
import {
  agentExplanationToMarkdown,
  agentListToMarkdown,
  allAgentActions,
  analyzeChange,
  assertSafeRef,
  buildEvidence,
  evaluateGate,
  evidenceToMarkdown,
  explainAgent,
  GENERIC_ORG_LABEL,
  gateToMarkdown,
  generateTests,
  loadProject,
  parseApprovals,
  run,
  runTests,
  saveProcedure,
  sourceRoots,
  testsToMarkdown,
  toJunit,
  toMarkdown,
  toSarif,
  type ValidationResult,
  validateTests,
  validationToMarkdown,
  verifyEvidence,
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

type Format = "md" | "json" | "sarif" | "junit";

function render(result: AnalysisResult, format: Format, failOn?: FailOn): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (format === "sarif") return JSON.stringify(toSarif(result, { toolVersion: version }), null, 2);
  if (format === "junit") return toJunit(result, result.gate?.failOn ?? failOn);
  return toMarkdown(result);
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${what} ${file}: ${(err as Error).message}`);
  }
}

interface PolicyOptions {
  project: string;
  base?: string;
  head?: string;
  files?: string[];
  depth: number;
  org?: string;
  failOn?: FailOn;
  /** Path, or false for --no-config. */
  config?: string | false;
  configRef?: string;
  approvals?: string;
  testsResult?: string;
  prNumber?: number;
  prHeadSha?: string;
  prUrl?: string;
}

const pullRequestOf = (opts: PolicyOptions) =>
  opts.prNumber ? { number: opts.prNumber, headSha: opts.prHeadSha, url: opts.prUrl } : undefined;

/** Analyze, then evaluate the quality gate from `.preflight.json`, approvals and test results. */
function analyzeWithPolicy(opts: PolicyOptions, withGate: boolean) {
  if (opts.configRef) assertSafeRef(opts.configRef, "config ref");
  const { model, result, policy } = analyzeChange({
    projectDir: opts.project,
    base: opts.base,
    head: opts.head,
    files: opts.files,
    maxDepth: opts.depth,
    org: opts.org,
    config: opts.config,
    configRef: opts.configRef,
  });
  const approvals = opts.approvals ? parseApprovals(readJson(opts.approvals, "approvals"), opts.approvals) : undefined;
  const tests = opts.testsResult ? (readJson(opts.testsResult, "tests result") as TestsResultFile) : undefined;
  if (withGate) {
    // When the policy needs passing tests but none were run, check whether the change has any.
    let testsGenerated = Array.isArray(tests?.tests) ? tests.tests.length : undefined;
    if (policy.gate?.requireTestsPassed && !tests) {
      try {
        testsGenerated = generateTests(model, result).tests.length;
      } catch {
        testsGenerated = undefined;
      }
    }
    result.gate = evaluateGate({
      result,
      config: { ...policy.gate, ...(opts.failOn ? { failOn: opts.failOn } : {}) },
      approvals,
      validation: tests?.validation,
      testsGenerated,
    });
  }
  return { result, approvals, tests };
}

const program = new Command();
program
  .name("preflight")
  .description("Preflight checks for Salesforce changes: what will this change set off?")
  .version(version);

const policyOptions = (cmd: Command) =>
  cmd
    .option("-p, --project <dir>", "SFDX project directory", ".")
    .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
    .option("--head <ref>", "git head ref (default: working tree)")
    .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
    .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
    .option("--org <alias>", "add read-only context from an org authorized with `sf org login` (beta)")
    .option("--config <file>", "policy file (default: .preflight.json in the project, then the git root)")
    .option("--no-config", "ignore .preflight.json")
    .option("--config-ref <ref>", "read the policy from git at this ref, e.g. the pull request's base branch")
    .option("--approvals <file>", "JSON list of approvals (reviewer names), for the gate and evidence")
    .option("--tests-result <file>", "output of `preflight tests --validate --format json`, for the gate and evidence")
    .option("--pr-number <n>", "pull request number, recorded in the evidence", (v) => Number.parseInt(v, 10))
    .option("--pr-head-sha <sha>", "pull request head commit, recorded in the evidence")
    .option("--pr-url <url>", "pull request URL, recorded in the evidence");

policyOptions(
  program.command("analyze").description("Analyze a change (git diff or explicit files) in an SFDX project"),
)
  .addOption(new Option("--format <format>", "output format").choices(["md", "json", "sarif", "junit"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--md-out <file>", "also write a Markdown report to this file")
  .option("--json-out <file>", "also write a JSON report to this file")
  .option("--sarif-out <file>", "also write a SARIF report to this file")
  .option("--junit-out <file>", "also write JUnit XML (for CI test reports) to this file")
  .option("--evidence-out <file>", "also write the change's evidence pack (JSON) to this file")
  .option("--gate", "evaluate the quality gate from .preflight.json; exit with code 2 when it fails")
  .addOption(
    new Option(
      "--fail-on <level>",
      "exit with code 2 when risk is at or above this level (with --gate: the gate's threshold)",
    ).choices(["low", "medium", "high", "none"]),
  )
  .action(
    (
      opts: PolicyOptions & {
        format: Format;
        out?: string;
        mdOut?: string;
        jsonOut?: string;
        sarifOut?: string;
        junitOut?: string;
        evidenceOut?: string;
        gate?: boolean;
      },
    ) => {
      const { result, approvals, tests } = analyzeWithPolicy(opts, !!opts.gate || !!opts.evidenceOut);
      const output = render(result, opts.format, opts.failOn);
      if (opts.out) writeFileSync(opts.out, `${output}\n`);
      else process.stdout.write(`${output}\n`);
      if (opts.mdOut) writeFileSync(opts.mdOut, `${render(result, "md")}\n`);
      if (opts.jsonOut) writeFileSync(opts.jsonOut, `${render(result, "json")}\n`);
      if (opts.sarifOut) writeFileSync(opts.sarifOut, `${render(result, "sarif")}\n`);
      if (opts.junitOut) writeFileSync(opts.junitOut, `${render(result, "junit", opts.failOn)}\n`);
      if (opts.evidenceOut) {
        const pack = buildEvidence({
          result,
          gate: result.gate!,
          version,
          approvals,
          tests,
          pullRequest: pullRequestOf(opts),
        });
        writeFileSync(opts.evidenceOut, `${JSON.stringify(pack, null, 2)}\n`);
      }
      if (opts.gate) {
        if (result.gate?.status === "fail") process.exitCode = 2;
      } else if (opts.failOn && opts.failOn !== "none" && RISK_RANK[result.summary.risk] >= RISK_RANK[opts.failOn]) {
        process.exitCode = 2;
      }
    },
  );

policyOptions(
  program
    .command("evidence")
    .description("Write the evidence pack for a change: what changed, who wrote it, findings, tests, approvals, gate"),
)
  .option("-o, --out <file>", "where to write the evidence JSON", "preflight-evidence.json")
  .option("--gate", "exit with code 2 when the quality gate fails")
  .addOption(
    new Option("--fail-on <level>", "the gate's severity threshold").choices(["low", "medium", "high", "none"]),
  )
  .option("--verify <file>", "check an evidence file's digest instead of creating one")
  .action((opts: PolicyOptions & { out: string; gate?: boolean; verify?: string }) => {
    if (opts.verify) {
      const pack = readJson(opts.verify, "evidence");
      if (!verifyEvidence(pack)) {
        process.stderr.write(
          `${opts.verify}: not an sf-preflight evidence pack, or its digest doesn't match its content.\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${opts.verify}: digest matches (sha256:${pack.digest.value}). This shows the file is intact; to show who produced it, verify its attestation (see docs/EVIDENCE.md).\n`,
      );
      return;
    }
    const { result, approvals, tests } = analyzeWithPolicy(opts, true);
    const pack = buildEvidence({
      result,
      gate: result.gate!,
      version,
      approvals,
      tests,
      pullRequest: pullRequestOf(opts),
    });
    writeFileSync(opts.out, `${JSON.stringify(pack, null, 2)}\n`);
    process.stdout.write(`${evidenceToMarkdown(pack)}\n\n${gateToMarkdown(pack.gate)}\n`);
    process.stderr.write(`Wrote ${opts.out}\n`);
    if (opts.gate && pack.gate.status === "fail") process.exitCode = 2;
  });

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
