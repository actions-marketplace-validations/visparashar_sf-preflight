// SPDX-License-Identifier: Apache-2.0
import type { AgentTestDef, AnalysisResult, OrgModel } from "../types.js";
import { key, redactEmails, uniq } from "../util.js";
import { orgLabel, orgRef } from "./enrich.js";
import { assertSafeOrg, createSfRunner, SfError, type SfRunner } from "./sf.js";
import { checkTestOrg, type OrgKind } from "./validate.js";

/**
 * Runs Agentforce Testing Center tests (`sf agent test run`) for the agents a change affects and
 * reports each test case. Testing Center runs against the agent as deployed in the org, and agent
 * actions really run, so this belongs after deploying the change to a sandbox.
 */

export interface AgentTestCase {
  number: number;
  utterance?: string;
  outcome: "pass" | "fail" | "error";
  /** What didn't match, e.g. "action_sequence_match: expected ['A'], got ['B']". */
  failures: string[];
}

export interface AgentTestRun {
  test: string;
  agent: string;
  status: "passed" | "failed" | "error" | "timeout";
  runId?: string;
  cases: AgentTestCase[];
  message?: string;
}

export interface AgentTestsResult {
  /** Org alias, never a username. */
  org: string;
  orgKind: OrgKind;
  runs: AgentTestRun[];
  status: "passed" | "failed";
}

/**
 * Testing Center tests to run for a change: those of affected agents that expect an affected action
 * or its topic, or every test of the affected agents with `all`. `names` picks tests explicitly.
 */
export function selectAgentTests(
  model: OrgModel,
  result: AnalysisResult,
  opts: { all?: boolean; names?: string[] } = {},
): AgentTestDef[] {
  if (opts.names?.length) {
    const wanted = new Set(opts.names.map(key));
    const found = model.agentTests.filter((t) => wanted.has(key(t.name)));
    const missing = opts.names.filter((n) => !found.some((t) => key(t.name) === key(n)));
    if (missing.length) throw new Error(`No Testing Center test named ${missing.join(", ")} in the project.`);
    return found;
  }
  const affected = result.agents ?? [];
  return model.agentTests.filter((t) => {
    const impacts = affected.filter((a) => key(a.agent) === key(t.subject));
    if (!impacts.length) return false;
    if (opts.all) return true;
    const actions = new Set(impacts.map((a) => key(a.action)));
    const topics = new Set(
      impacts
        .map((a) => a.topic)
        .filter((x): x is string => !!x)
        .map(key),
    );
    return t.actions.some((a) => actions.has(key(a))) || t.topics.some((x) => topics.has(key(x)));
  });
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const list = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Topic and action expectations compare metadata names, which are safe to show. Other expectations
 * compare the agent's response, which can contain record data, so their values stay out of reports.
 */
const NAMES_ONLY = /topic|action/i;
const mismatch = (name: string, expected: string, actual: string) =>
  clip(
    NAMES_ONLY.test(name)
      ? `${name}: expected ${expected}, got ${actual}`
      : `${name}: didn't match (the agent's response isn't included in reports)`,
  );

interface LegacyCase {
  status?: string;
  testNumber?: number;
  inputs?: { utterance?: string };
  testResults?: {
    name?: string;
    result?: string | null;
    expectedValue?: string;
    actualValue?: string;
    errorMessage?: string;
    status?: string;
  }[];
}

interface StudioCase {
  testNumber?: number;
  testScorerResults?: { scorerName?: string; scorerResponse?: string }[];
}

/** Test case outcomes from `sf agent test run --json` (Testing Center or Agentforce Studio format). */
export function readAgentTestResult(raw: unknown): { cases: AgentTestCase[]; message?: string } {
  const r = (raw ?? {}) as { testCases?: unknown; errorMessage?: string };
  const cases: AgentTestCase[] = [];
  for (const [i, c] of list(r.testCases as (LegacyCase & StudioCase)[]).entries()) {
    const number = typeof c.testNumber === "number" ? c.testNumber : i + 1;
    if (Array.isArray(c.testScorerResults)) {
      // Agentforce Studio: a scorer with an expected value passes when the actual value equals it.
      // Scorers without one (quality metrics) can't be judged here and are left out.
      const failures: string[] = [];
      let judged = 0;
      for (const s of c.testScorerResults) {
        let parsed: { actualValue?: unknown; expectedValue?: unknown } = {};
        try {
          const v = JSON.parse(s.scorerResponse ?? "{}");
          if (v && typeof v === "object") parsed = v;
        } catch {
          parsed = {};
        }
        if (parsed.expectedValue === undefined) continue;
        judged++;
        if (JSON.stringify(parsed.actualValue) !== JSON.stringify(parsed.expectedValue)) {
          failures.push(
            mismatch(
              s.scorerName ?? "scorer",
              JSON.stringify(parsed.expectedValue),
              JSON.stringify(parsed.actualValue ?? null),
            ),
          );
        }
      }
      cases.push({
        number,
        outcome: !judged ? "error" : failures.length ? "fail" : "pass",
        failures: judged ? failures : ["no scorer results with an expected value"],
      });
      continue;
    }
    // Testing Center: every evaluated expectation must pass.
    const results = list(c.testResults);
    const errors = results.filter((t) => t.status === "ERROR" || t.errorMessage);
    const failures = results
      .filter((t) => t.result === "FAILURE")
      .map((t) => mismatch(t.name ?? "expectation", t.expectedValue ?? "?", t.actualValue ?? "?"));
    const outcome = c.status === "ERROR" || errors.length ? "error" : failures.length ? "fail" : "pass";
    cases.push({
      number,
      utterance: c.inputs?.utterance ? clip(c.inputs.utterance, 160) : undefined,
      outcome,
      failures: [
        ...failures,
        ...errors.map((t) => clip(redactEmails(`${t.name ?? "expectation"}: ${t.errorMessage ?? "error"}`))),
      ],
    });
  }
  return { cases, message: r.errorMessage ? clip(redactEmails(r.errorMessage)) : undefined };
}

export interface RunAgentTestsOptions {
  org: string;
  tests: AgentTestDef[];
  /** Minutes to wait for each test run (default 10). */
  waitMinutes?: number;
  allowProduction?: boolean;
  runner?: SfRunner;
}

/** Run each test with `sf agent test run` and collect the outcomes. */
export function runAgentTests(opts: RunAgentTestsOptions): AgentTestsResult {
  const org = assertSafeOrg(opts.org);
  const wait = opts.waitMinutes ?? 10;
  if (!Number.isInteger(wait) || wait < 1 || wait > 120) throw new SfError("--wait must be between 1 and 120 minutes.");
  const run = opts.runner ?? createSfRunner({ timeoutMs: (wait + 3) * 60_000 });
  const { label, kind } = checkTestOrg(run, org, {
    allowProduction: opts.allowProduction,
    production:
      "Testing Center runs agent actions for real; run it in a sandbox, scratch org or Developer Edition org, or pass --allow-production.",
    unknown: "Testing Center runs agent actions for real. Pass --allow-production to run anyway.",
  });

  const runs: AgentTestRun[] = [];
  for (const t of opts.tests) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t.name)) {
      runs.push({ test: t.name, agent: t.subject, status: "error", cases: [], message: "Unsupported test name." });
      continue;
    }
    const args = [
      "agent",
      "test",
      "run",
      "--api-name",
      t.name,
      "--wait",
      String(wait),
      "--target-org",
      org,
      "--test-runner",
      t.format === "AiTestingDefinition" ? "agentforce-studio" : "testing-center",
    ];
    try {
      let raw: { status?: string; runId?: string } | undefined;
      try {
        raw = run(args) as typeof raw;
      } catch (err) {
        // Older Salesforce CLIs don't know --test-runner and only run Testing Center tests.
        const unknownFlag = /test-runner/i.test((err as Error).message) && t.format === "AiEvaluationDefinition";
        if (!unknownFlag) throw err;
        raw = run(args.slice(0, -2)) as typeof raw;
      }
      if (raw?.status === "IN_PROGRESS" || raw?.status === "NEW") {
        runs.push({
          test: t.name,
          agent: t.subject,
          status: "timeout",
          runId: raw.runId,
          cases: [],
          message: `Still running after ${wait} minutes; check it with \`sf agent test results --job-id ${raw.runId ?? "<id>"}\`.`,
        });
        continue;
      }
      const { cases, message } = readAgentTestResult(raw);
      const status = !cases.length
        ? "error"
        : cases.some((c) => c.outcome === "error")
          ? "error"
          : cases.some((c) => c.outcome === "fail")
            ? "failed"
            : "passed";
      runs.push({
        test: t.name,
        agent: t.subject,
        status,
        runId: raw?.runId,
        cases,
        message: message ?? (cases.length ? undefined : "The run returned no test cases."),
      });
    } catch (err) {
      runs.push({
        test: t.name,
        agent: t.subject,
        status: "error",
        cases: [],
        message: clip(redactEmails((err as Error).message)),
      });
    }
  }
  return {
    org: label,
    orgKind: kind,
    runs,
    status: overall(runs),
  };
}

const overall = (runs: AgentTestRun[]): AgentTestsResult["status"] =>
  runs.every((r) => r.status === "passed") ? "passed" : "failed";

/** The result when the change affects no tested agent actions: nothing ran, nothing failed. */
export function noAgentTests(org: string): AgentTestsResult {
  return { org: orgLabel(assertSafeOrg(org)), orgKind: "unknown", runs: [], status: "passed" };
}

const RUN_STATUSES = new Set(["passed", "failed", "error", "timeout"]);
const CASE_OUTCOMES = new Set(["pass", "fail", "error"]);

/**
 * Check a saved `preflight agent-tests --format json` result before the gate or evidence use it.
 * The overall status is recomputed from the runs, so it always agrees with them.
 */
export function parseAgentTestsResult(raw: unknown, source: string): AgentTestsResult {
  const bad = (why: string) =>
    new Error(`${source} isn't the output of \`preflight agent-tests --org <alias> --format json\`: ${why}.`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("expected an object");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.runs)) throw bad(Array.isArray(r.tests) ? "this is a --dry-run list" : "missing runs");
  if (typeof r.org !== "string" || !r.org) throw bad("missing org");
  const runs = r.runs.map((x, i): AgentTestRun => {
    const run = (x ?? {}) as Record<string, unknown>;
    if (typeof run.test !== "string" || typeof run.agent !== "string") throw bad(`run ${i + 1} has no test or agent`);
    if (typeof run.status !== "string" || !RUN_STATUSES.has(run.status)) throw bad(`run ${i + 1} has no valid status`);
    if (!Array.isArray(run.cases)) throw bad(`run ${i + 1} has no cases`);
    const cases = run.cases.map((c, j): AgentTestCase => {
      const tc = (c ?? {}) as Record<string, unknown>;
      if (typeof tc.outcome !== "string" || !CASE_OUTCOMES.has(tc.outcome))
        throw bad(`case ${j + 1} of run ${i + 1} has no valid outcome`);
      return {
        number: typeof tc.number === "number" ? tc.number : j + 1,
        utterance: typeof tc.utterance === "string" ? tc.utterance : undefined,
        outcome: tc.outcome as AgentTestCase["outcome"],
        failures: Array.isArray(tc.failures) ? tc.failures.filter((f): f is string => typeof f === "string") : [],
      };
    });
    if (run.status === "passed" && cases.some((c) => c.outcome !== "pass"))
      throw bad(`run ${i + 1} is marked passed but has cases that didn't pass`);
    return {
      test: run.test,
      agent: run.agent,
      status: run.status as AgentTestRun["status"],
      runId: typeof run.runId === "string" ? run.runId : undefined,
      cases,
      message: typeof run.message === "string" ? run.message : undefined,
    };
  });
  const orgKind = ["sandbox", "scratch", "developer", "production"].includes(String(r.orgKind))
    ? (r.orgKind as OrgKind)
    : "unknown";
  return { org: orgLabel(r.org), orgKind, runs, status: overall(runs) };
}

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const STATUS = { passed: "✅ passed", failed: "❌ failed", error: "⚠️ error", timeout: "⏳ still running" } as const;

/** Markdown section with each Testing Center run. */
export function agentTestsToMarkdown(r: AgentTestsResult): string {
  const out = [`### Testing Center in ${orgRef(r.org)}`, ""];
  if (!r.runs.length) {
    out.push("_No Testing Center tests cover the affected agent actions._");
    return out.join("\n");
  }
  const passed = r.runs.filter((x) => x.status === "passed").length;
  out.push(
    r.status === "passed"
      ? `✅ All ${r.runs.length} test run(s) passed.`
      : `❌ ${r.runs.length - passed} of ${r.runs.length} test run(s) didn't pass.`,
    "",
    "| Test | Agent | Result | Cases passed | Details |",
    "|---|---|---|---|---|",
  );
  for (const run of r.runs) {
    const ok = run.cases.filter((c) => c.outcome === "pass").length;
    const details = uniq(
      run.cases
        .filter((c) => c.outcome !== "pass")
        .flatMap((c) => c.failures.map((f) => `#${c.number}${c.utterance ? ` "${c.utterance}"` : ""}: ${f}`)),
    ).slice(0, 5);
    out.push(
      `| \`${cell(run.test)}\` | ${cell(run.agent)} | ${STATUS[run.status]} | ${run.cases.length ? `${ok}/${run.cases.length}` : "—"} | ${cell([...details, ...(run.message ? [run.message] : [])].join("; ") || "—")} |`,
    );
  }
  out.push(
    "",
    "Testing Center checks the agent as deployed in the org: deploy the change to this org before relying on these results.",
  );
  return out.join("\n");
}
