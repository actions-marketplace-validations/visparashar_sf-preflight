import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AgentTestDef,
  type AgentTestsResult,
  agentTestsToMarkdown,
  buildEvidence,
  evaluateGate,
  loadProject,
  noAgentTests,
  type OrgModel,
  parseAgentTestsResult,
  readAgentTestResult,
  run,
  runAgentTests,
  SfError,
  type SfRunner,
  selectAgentTests,
} from "../src/core/index.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const at = (rel: string) => path.join(FIXTURE, SRC, rel);

const legacyResult = (failing: boolean) => ({
  status: "COMPLETED",
  runId: "4KB000000000001",
  subjectName: "Sales_Agent",
  testCases: [
    {
      status: "COMPLETED",
      testNumber: 1,
      inputs: { utterance: "Log a call with Acme about renewal pricing." },
      generatedData: { actionsSequence: "['Log_Customer_Call']", topic: "Close_Deals", outcome: "Done" },
      testResults: [
        { name: "topic_sequence_match", result: "PASS", expectedValue: "Close_Deals", actualValue: "Close_Deals" },
        {
          name: "action_sequence_match",
          result: failing ? "FAILURE" : "PASS",
          expectedValue: "['Log_Customer_Call']",
          actualValue: failing ? "['Close_Opportunity']" : "['Log_Customer_Call']",
        },
        { name: "bot_response_rating", result: null, expectedValue: "Confirms", actualValue: "Logged" },
      ],
    },
  ],
});

function fakeRunner(responses: { org?: Record<string, unknown>; test?: unknown | Error } = {}) {
  const calls: string[][] = [];
  const runner = ((args: string[]) => {
    calls.push(args);
    const cmd = args.slice(0, 3).join(" ");
    if (cmd.startsWith("org display")) return { alias: "uat" };
    if (cmd.startsWith("data query")) {
      return {
        records: [
          {
            attributes: {},
            IsSandbox: true,
            OrganizationType: "Enterprise Edition",
            TrialExpirationDate: null,
            ...responses.org,
          },
        ],
      };
    }
    if (cmd === "agent test run") {
      if (responses.test instanceof Error) throw responses.test;
      return responses.test ?? legacyResult(false);
    }
    throw new Error(`unexpected sf call: ${args.join(" ")}`);
  }) as SfRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

let model: OrgModel;
beforeAll(() => {
  model = loadProject(FIXTURE);
});

describe("choosing Testing Center tests", () => {
  it("picks tests of affected agents that expect an affected action or its topic", () => {
    const cls = run({ projectDir: FIXTURE, files: [at("classes/OpportunityCloser.cls")] });
    expect(selectAgentTests(model, cls).map((t) => t.name)).toEqual(["Sales_Agent_Tests"]);
    const unrelated = run({
      projectDir: FIXTURE,
      files: [at("permissionsets/Agent_Runtime_User.permissionset-meta.xml")],
    });
    expect(selectAgentTests(model, unrelated)).toEqual([]);
    // Service Agent is affected by this change but has no tests.
    const script = run({ projectDir: FIXTURE, files: [at("aiAuthoringBundles/Service_Agent/Service_Agent.agent")] });
    expect(selectAgentTests(model, script, { all: true })).toEqual([]);
  });

  it("takes tests by name and reports unknown ones", () => {
    const none = run({ projectDir: FIXTURE, files: [at("permissionsets/Agent_Runtime_User.permissionset-meta.xml")] });
    expect(selectAgentTests(model, none, { names: ["sales_agent_tests"] }).map((t) => t.name)).toEqual([
      "Sales_Agent_Tests",
    ]);
    expect(() => selectAgentTests(model, none, { names: ["Nope"] })).toThrow("No Testing Center test named Nope");
  });
});

describe("reading test results", () => {
  it("reads Testing Center results: failed expectations and errors", () => {
    expect(readAgentTestResult(legacyResult(false)).cases).toEqual([
      { number: 1, utterance: "Log a call with Acme about renewal pricing.", outcome: "pass", failures: [] },
    ]);
    expect(readAgentTestResult(legacyResult(true)).cases[0]).toMatchObject({
      outcome: "fail",
      failures: ["action_sequence_match: expected ['Log_Customer_Call'], got ['Close_Opportunity']"],
    });
    const errored = readAgentTestResult({
      testCases: [{ status: "ERROR", testResults: [{ name: "topic_sequence_match", errorMessage: "timed out" }] }],
    });
    expect(errored.cases[0]).toMatchObject({ outcome: "error", failures: ["topic_sequence_match: timed out"] });
  });

  it("reads Agentforce Studio results by comparing each scorer's values", () => {
    const r = readAgentTestResult({
      status: "SUCCESS",
      testCases: [
        {
          testNumber: 1,
          testScorerResults: [
            { scorerName: "topic_sequence_match", scorerResponse: '{"expectedValue":"A","actualValue":"A"}' },
          ],
        },
        {
          testNumber: 2,
          testScorerResults: [
            { scorerName: "action_sequence_match", scorerResponse: '{"expectedValue":"X","actualValue":"Y"}' },
            { scorerName: "coherence", scorerResponse: "not json" },
          ],
        },
      ],
    });
    expect(r.cases.map((c) => `${c.number}:${c.outcome}`)).toEqual(["1:pass", "2:fail"]);
    expect(r.cases[1]!.failures).toEqual(['action_sequence_match: expected "X", got "Y"']);
    // Quality metrics have no expected value; a case with nothing to judge is an error, not a pass.
    const unjudged = readAgentTestResult({
      testCases: [{ testScorerResults: [{ scorerName: "coherence", scorerResponse: '{"score":4}' }] }],
    });
    expect(unjudged.cases[0]).toMatchObject({ outcome: "error" });
  });

  it("keeps the agent's responses out of the results", () => {
    const r = readAgentTestResult({
      testCases: [
        {
          testResults: [
            {
              name: "output_validation",
              result: "FAILURE",
              expectedValue: "Confirms the call was logged",
              actualValue: "Logged a call for Jane Doe, jane@acme.com, about the $48,000 renewal.",
            },
          ],
        },
        {
          testScorerResults: [
            {
              scorerName: "output_evaluation",
              scorerResponse: '{"expectedValue":"ok","actualValue":"Jane Doe owes $48,000"}',
            },
          ],
        },
      ],
    });
    expect(r.cases.map((c) => c.outcome)).toEqual(["fail", "fail"]);
    expect(JSON.stringify(r)).not.toMatch(/Jane|48,000|acme/);
    expect(r.cases[0]!.failures).toEqual([
      "output_validation: didn't match (the agent's response isn't included in reports)",
    ]);
  });
});

describe("running Testing Center tests", () => {
  const tests = (): AgentTestDef[] => model.agentTests;

  it("runs each test in the org and reports the outcomes", () => {
    const runner = fakeRunner({ test: legacyResult(true) });
    const r = runAgentTests({ org: "uat", tests: tests(), runner });
    expect(r).toMatchObject({ org: "uat", orgKind: "sandbox", status: "failed" });
    expect(r.runs[0]).toMatchObject({ test: "Sales_Agent_Tests", agent: "Sales_Agent", status: "failed" });
    expect(runner.calls.at(-1)).toEqual([
      "agent",
      "test",
      "run",
      "--api-name",
      "Sales_Agent_Tests",
      "--wait",
      "10",
      "--target-org",
      "uat",
      "--test-runner",
      "testing-center",
    ]);
    const md = agentTestsToMarkdown(r);
    expect(md).toContain("### Testing Center in uat");
    expect(md).toContain("❌ 1 of 1 test run(s) didn't pass.");
    expect(md).toContain(
      '| `Sales_Agent_Tests` | Sales_Agent | ❌ failed | 0/1 | #1 "Log a call with Acme about renewal pricing.": action_sequence_match',
    );
    expect(md).toContain("deploy the change to this org before relying on these results");
  });

  it("passes when every case passes, and reports runs still in progress", () => {
    expect(runAgentTests({ org: "uat", tests: tests(), runner: fakeRunner() }).status).toBe("passed");
    const slow = runAgentTests({
      org: "uat",
      tests: tests(),
      runner: fakeRunner({ test: { status: "IN_PROGRESS", runId: "4KB1" } }),
    });
    expect(slow.runs[0]).toMatchObject({ status: "timeout", runId: "4KB1" });
    expect(slow.runs[0]!.message).toContain("sf agent test results --job-id 4KB1");
    expect(agentTestsToMarkdown(slow)).toContain("⏳ still running");
  });

  it("retries without --test-runner on older Salesforce CLIs", () => {
    let first = true;
    const runner = ((args: string[]) => {
      if (args[0] === "agent" && first) {
        first = false;
        throw new SfError("Nonexistent flag: --test-runner");
      }
      return fakeRunner()(args);
    }) as SfRunner;
    expect(runAgentTests({ org: "uat", tests: tests(), runner }).status).toBe("passed");
  });

  it("keeps going when a test can't run, without leaking usernames", () => {
    const r = runAgentTests({
      org: "uat",
      tests: tests(),
      runner: fakeRunner({ test: new SfError("No agent for admin@acme.com") }),
    });
    expect(r.runs[0]).toMatchObject({ status: "error", message: "No agent for <username>" });
  });

  it("refuses production orgs unless allowed", () => {
    const prod = { IsSandbox: false, OrganizationType: "Enterprise Edition" };
    expect(() => runAgentTests({ org: "prod", tests: tests(), runner: fakeRunner({ org: prod }) })).toThrow(
      /production org\. Testing Center runs agent actions for real/,
    );
    expect(
      runAgentTests({ org: "prod", tests: tests(), runner: fakeRunner({ org: prod }), allowProduction: true }).status,
    ).toBe("passed");
  });
});

describe("Testing Center results in the gate and evidence", () => {
  const affected = () => run({ projectDir: FIXTURE, files: [at("classes/OpportunityCloser.cls")], config: false });
  const result = (status: "passed" | "failed"): AgentTestsResult =>
    runAgentTests({
      org: "uat",
      tests: model.agentTests,
      runner: fakeRunner({ test: legacyResult(status === "failed") }),
    });

  it("gates on the Testing Center results", () => {
    const r = affected();
    const config = { failOn: "none" as const, requireAgentTestsPassed: true };
    const check = (agentTests?: AgentTestsResult) =>
      evaluateGate({ result: r, config, agentTests }).checks.find((c) => c.id === "agent-tests-passed")!;
    expect(check()).toMatchObject({ status: "fail" });
    expect(check().detail).toContain("preflight agent-tests --org <sandbox> --format json");
    expect(check(result("passed"))).toMatchObject({ status: "pass", detail: "1 of 1 test run(s) passed in uat." });
    expect(check(result("failed"))).toMatchObject({ status: "fail" });
    // A result from another change, or a run that left out a covering test, doesn't pass.
    const expected = selectAgentTests(model, r).map((t) => t.name);
    const fromElsewhere = evaluateGate({
      result: r,
      config,
      agentTests: noAgentTests("uat"),
      expectedAgentTests: expected,
    });
    expect(fromElsewhere.checks.find((c) => c.id === "agent-tests-passed")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("weren't in the result: `Sales_Agent_Tests`"),
    });
    const covered = evaluateGate({ result: r, config, agentTests: result("passed"), expectedAgentTests: expected });
    expect(covered.status).toBe("pass");
    const none = run({
      projectDir: FIXTURE,
      files: [at("permissionsets/Agent_Runtime_User.permissionset-meta.xml")],
      config: false,
    });
    expect(evaluateGate({ result: none, config }).checks.find((c) => c.id === "agent-tests-passed")).toMatchObject({
      status: "pass",
      detail: "No agent actions affected.",
    });
  });

  it("records the runs in the evidence", () => {
    const r = affected();
    const e = buildEvidence({
      result: r,
      gate: evaluateGate({ result: r }),
      version: "1",
      agentTests: result("failed"),
    });
    expect(e.tests.agentTests).toEqual({
      org: "uat",
      status: "failed",
      runs: [{ test: "Sales_Agent_Tests", agent: "Sales_Agent", status: "failed", passed: 0, failed: 1 }],
    });
  });
});

describe("saved Testing Center results", () => {
  it("reads back a saved result and recomputes its status", () => {
    const saved = JSON.parse(
      JSON.stringify(runAgentTests({ org: "uat", tests: model.agentTests, runner: fakeRunner() })),
    );
    expect(parseAgentTestsResult(saved, "r.json")).toMatchObject({ org: "uat", status: "passed" });
    saved.runs[0].status = "error";
    expect(parseAgentTestsResult(saved, "r.json").status).toBe("failed");
    saved.status = "passed";
    expect(parseAgentTestsResult(saved, "r.json").status).toBe("failed");
  });

  it("rejects files that aren't agent-tests results", () => {
    expect(() => parseAgentTestsResult({ tests: [] }, "r.json")).toThrow("this is a --dry-run list");
    expect(() => parseAgentTestsResult([], "r.json")).toThrow("expected an object");
    expect(() =>
      parseAgentTestsResult(
        { org: "uat", runs: [{ test: "T", agent: "A", status: "passed", cases: [{ outcome: "fail" }] }] },
        "r.json",
      ),
    ).toThrow("marked passed but has cases that didn't pass");
  });

  it("writes an empty, passing result when nothing needs to run, without usernames", () => {
    expect(noAgentTests("admin@acme.com")).toEqual({
      org: "target org",
      orgKind: "unknown",
      runs: [],
      status: "passed",
    });
    expect(agentTestsToMarkdown(noAgentTests("uat"))).toContain("No Testing Center tests cover");
  });
});
