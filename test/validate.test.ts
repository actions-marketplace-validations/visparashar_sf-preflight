import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSfRunner,
  readDeployResult,
  SfError,
  type SfRunner,
  type ValidateTestsOptions,
  validateTests,
  validationToMarkdown,
} from "../src/core/index.js";
import { redactEmails } from "../src/core/util.js";

const CLASS = "PreflightChangeTest";
const METHODS = ["bulkUpdateOpportunity", "bulkInsertOpportunity", "recursionAccountContact"];
const DEPLOY_ID = "0Af5g00000ABCDEFGH";

type Org = { IsSandbox: boolean; OrganizationType: string; TrialExpirationDate: string | null };
const SANDBOX: Org = { IsSandbox: true, OrganizationType: "Enterprise Edition", TrialExpirationDate: null };

interface FakeOptions {
  alias?: string;
  org?: Org | Error;
  validate?: unknown;
  report?: unknown;
}

function fakeRunner(o: FakeOptions = {}): SfRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const answer = (v: unknown) => {
    if (v instanceof Error) throw v;
    return v;
  };
  const runner = ((args: string[]) => {
    calls.push(args);
    const cmd = args.slice(0, 3).join(" ");
    if (cmd.startsWith("org display")) return { id: "00D000000000001", alias: o.alias ?? "dev" };
    if (cmd.startsWith("data query")) {
      const org = answer(o.org ?? SANDBOX) as Org;
      return { records: [{ attributes: { type: "Organization" }, ...org }], totalSize: 1, done: true };
    }
    if (cmd === "project deploy validate") return answer(o.validate);
    if (cmd === "project deploy report") return answer(o.report);
    throw new Error(`unexpected sf call: ${args.join(" ")}`);
  }) as SfRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

const options = (runner: SfRunner, extra: Partial<ValidateTestsOptions> = {}): ValidateTestsOptions => ({
  org: "dev",
  projectDir: "/project",
  sourceDirs: ["force-app"],
  testsDir: "preflight-tests",
  className: CLASS,
  methods: METHODS,
  runner,
  ...extra,
});

const success = (name: string, methodName: string) => ({ name, methodName, time: "1234" });
const failedValidation = () =>
  new SfError(
    `Failed to validate the deployment (${DEPLOY_ID}). Due To:\n${CLASS}.recursionAccountContact - System.LimitException: Too many SOQL queries: 101`,
    "FailedValidationError",
    { deployId: DEPLOY_ID },
  );

describe("validateTests", () => {
  it("runs a check-only deployment of the project and the tests", () => {
    const runner = fakeRunner({
      validate: {
        id: DEPLOY_ID,
        status: "Succeeded",
        success: true,
        details: { runTestResult: { successes: METHODS.map((m) => success(CLASS, m)) } },
      },
    });
    const v = validateTests(options(runner));
    expect(v).toMatchObject({ org: "dev", orgKind: "sandbox", status: "passed", deployId: DEPLOY_ID });
    expect(v.tests.map((t) => t.outcome)).toEqual(["pass", "pass", "pass"]);
    expect(runner.calls.at(-1)).toEqual([
      "project",
      "deploy",
      "validate",
      "--source-dir",
      "force-app",
      "--source-dir",
      "preflight-tests",
      "--test-level",
      "RunSpecifiedTests",
      "--tests",
      CLASS,
      "--target-org",
      "dev",
      "--wait",
      "33",
      "--concise",
    ]);
    const md = validationToMarkdown(v);
    expect(md).toContain("### Run in dev");
    expect(md).toContain("✅ All 3 tests passed. Check-only deployment");
    expect(md).toContain("| `bulkInsertOpportunity` | ✅ pass | 1.2 s |");
  });

  it("reads failures from the deploy report when the validation fails", () => {
    const runner = fakeRunner({
      validate: failedValidation(),
      report: {
        id: DEPLOY_ID,
        status: "Failed",
        success: false,
        details: {
          runTestResult: {
            successes: [success(CLASS, "bulkUpdateOpportunity"), success("SomeOtherTest", "unrelated")],
            failures: {
              name: CLASS,
              methodName: "recursionAccountContact",
              message: "System.LimitException: Too many SOQL queries: 101 for jane.doe@example.com",
              stackTrace: "Class.ContactTriggerHandler.sync: line 12, column 1\nTrigger.ContactTrigger: line 3",
            },
          },
        },
      },
    });
    const v = validateTests(options(runner));
    expect(v.status).toBe("failed");
    expect(v.tests).toEqual([
      { method: "bulkUpdateOpportunity", outcome: "pass", ms: 1234 },
      { method: "bulkInsertOpportunity", outcome: "not run" },
      {
        method: "recursionAccountContact",
        outcome: "fail",
        message:
          "System.LimitException: Too many SOQL queries: 101 for <username> (Class.ContactTriggerHandler.sync: line 12, column 1)",
        ms: undefined,
      },
    ]);
    expect(runner.calls.at(-1)).toEqual(["project", "deploy", "report", "--job-id", DEPLOY_ID, "--target-org", "dev"]);
    const md = validationToMarkdown(v);
    expect(md).toContain("❌ 1 of 3 tests failed.");
    expect(md).toContain(`Deployment ID: \`${DEPLOY_ID}\``);
    expect(md).not.toContain("@");
  });

  it("reports compile errors and keeps only errors, not warnings", () => {
    const runner = fakeRunner({
      validate: failedValidation(),
      report: {
        id: DEPLOY_ID,
        success: false,
        details: {
          componentFailures: [
            {
              componentType: "ApexClass",
              fullName: CLASS,
              lineNumber: "42",
              problem: "Variable does not exist: Customer_Tier__c",
              problemType: "Error",
            },
            { componentType: "ApexClass", fullName: "Other", problem: "deprecated", problemType: "Warning" },
          ],
        },
      },
    });
    const v = validateTests(options(runner));
    expect(v.componentErrors).toEqual([
      { type: "ApexClass", name: CLASS, line: 42, problem: "Variable does not exist: Customer_Tier__c" },
    ]);
    expect(v.tests.every((t) => t.outcome === "not run")).toBe(true);
    const md = validationToMarkdown(v);
    expect(md).toContain(
      "❌ The deployment has 1 component error(s); no tests ran. Check-only deployment: nothing was saved",
    );
    expect(md).toContain(`| ApexClass ${CLASS} | 42 | Variable does not exist: Customer_Tier__c |`);
    expect(md).not.toContain("| Test | Result |");
  });

  it("falls back to the error message when the report can't be read", () => {
    const runner = fakeRunner({ validate: failedValidation(), report: new SfError("report failed") });
    const v = validateTests(options(runner));
    expect(v.status).toBe("failed");
    expect(v.tests.find((t) => t.method === "recursionAccountContact")).toEqual({
      method: "recursionAccountContact",
      outcome: "fail",
      message: "System.LimitException: Too many SOQL queries: 101",
    });
    expect(validationToMarkdown(v)).toContain("Failed to validate the deployment");
  });

  it("tells failed setup apart from failed checks", () => {
    const v = readDeployResult(
      {
        id: DEPLOY_ID,
        success: false,
        details: {
          runTestResult: {
            successes: [success(CLASS, "bulkInsertOpportunity")],
            failures: [
              {
                name: CLASS,
                methodName: "bulkUpdateOpportunity",
                message:
                  "PreflightDataFactory.PreflightException: Could not create test Account records: REQUIRED_FIELD_MISSING",
              },
              {
                name: CLASS,
                methodName: "recursionAccountContact",
                message: "System.LimitException: Too many SOQL queries: 101",
              },
            ],
          },
        },
      },
      CLASS,
      METHODS,
    );
    expect(v.tests.map((t) => t.outcome)).toEqual(["setup failed", "pass", "fail"]);
    const md = validationToMarkdown({ org: "dev", orgKind: "developer", ...v });
    expect(md).toContain("❌ 1 of 3 tests failed, and 1 couldn't create their test data in this org.");
    expect(md).toContain("| `bulkUpdateOpportunity` | ⚠️ setup failed |");
    expect(md).toContain("A test whose setup failed stopped before checking anything");
    const onlySetup = validationToMarkdown({
      org: "dev",
      orgKind: "developer",
      ...v,
      tests: v.tests.filter((t) => t.outcome !== "fail"),
    });
    expect(onlySetup).toContain("⚠️ 1 of 2 tests couldn't create their test data in this org; the others passed.");
  });

  it("explains a deployment rejected only on code coverage", () => {
    const v = readDeployResult(
      {
        id: DEPLOY_ID,
        success: false,
        details: {
          runTestResult: {
            successes: METHODS.map((m) => success(CLASS, m)),
            codeCoverageWarnings: [
              { name: "OpportunityCloser", message: "Test coverage of selected Apex Class is 0%" },
            ],
          },
        },
      },
      CLASS,
      METHODS,
    );
    const md = validationToMarkdown({ org: "dev", orgKind: "sandbox", ...v });
    expect(md).toContain("❌ All 3 tests passed, but Salesforce rejected the deployment on code coverage");
    expect(md).toContain("- OpportunityCloser: Test coverage of selected Apex Class is 0%");
  });

  it("throws other sf errors", () => {
    const runner = fakeRunner({
      validate: new SfError("This command is required to run from within a Salesforce project directory."),
    });
    expect(() => validateTests(options(runner))).toThrow(/Validation in dev failed: This command is required/);
  });

  it("refuses production orgs unless allowed", () => {
    const prod = { IsSandbox: false, OrganizationType: "Enterprise Edition", TrialExpirationDate: null };
    const passing = { id: DEPLOY_ID, success: true, details: { runTestResult: { successes: [] } } };
    expect(() => validateTests(options(fakeRunner({ org: prod, validate: passing })))).toThrow(
      /dev is a production org.*--allow-production/,
    );
    const allowed = validateTests(options(fakeRunner({ org: prod, validate: passing }), { allowProduction: true }));
    expect(allowed.orgKind).toBe("production");
    expect(() => validateTests(options(fakeRunner({ org: new Error("no access"), validate: passing })))).toThrow(
      /Couldn't tell whether dev is a sandbox/,
    );
  });

  it("allows Developer Edition and scratch orgs", () => {
    const passing = { id: DEPLOY_ID, success: true, details: {} };
    const dev = { IsSandbox: false, OrganizationType: "Developer Edition", TrialExpirationDate: null };
    const scratch = { IsSandbox: false, OrganizationType: "Enterprise Edition", TrialExpirationDate: "2026-11-01" };
    expect(validateTests(options(fakeRunner({ org: dev, validate: passing }))).orgKind).toBe("developer");
    expect(validateTests(options(fakeRunner({ org: scratch, validate: passing }))).orgKind).toBe("scratch");
  });

  it("never names an org by its username", () => {
    const runner = fakeRunner({
      alias: "",
      validate: { id: DEPLOY_ID, success: true, details: { runTestResult: { successes: [] } } },
    });
    const v = validateTests(options(runner, { org: "jane.doe@example.com.uat", methods: [] }));
    expect(v.org).toBe("target org");
    expect(validationToMarkdown(v)).toContain("### Run in the target org");
  });

  it("validates the org and wait time", () => {
    expect(() => validateTests(options(fakeRunner(), { org: "--target-org" }))).toThrow(/Invalid org/);
    expect(() => validateTests(options(fakeRunner(), { waitMinutes: 0 }))).toThrow(/--wait/);
  });
});

describe("redactEmails", () => {
  it("replaces email addresses and usernames", () => {
    expect(redactEmails("No authorization for jane.doe+uat@example.com.uat.")).toBe("No authorization for <username>.");
    expect(redactEmails("a@b, x_y%z@corp-mail.co.uk and @mention")).toBe("a@b, <username> and @mention");
    expect(redactEmails("user@host")).toBe("user@host");
  });

  it("stays fast on long inputs without an address", () => {
    const started = Date.now();
    redactEmails(`${"%".repeat(200_000)}@${".".repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("sf runner working directory and error data", () => {
  let bin: string;
  let project: string;
  const originalPath = process.env.PATH;
  beforeAll(() => {
    bin = mkdtempSync(path.join(tmpdir(), "sf-preflight-sfv-"));
    project = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-preflight-proj-")));
    const script = path.join(bin, "sf");
    writeFileSync(
      script,
      `#!/bin/sh
case "$*" in
  *"project deploy validate"*) echo '{"status":1,"name":"FailedValidationError","message":"Failed","data":{"deployId":"${DEPLOY_ID}"}}'; exit 1 ;;
  *) printf '{"status":0,"result":{"cwd":"%s"}}' "$PWD" ;;
esac
`,
    );
    chmodSync(script, 0o755);
  });
  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("runs sf in the project and keeps the error name and data", () => {
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const sf = createSfRunner({ cwd: project });
    expect(sf(["project", "deploy", "report"])).toEqual({ cwd: project });
    let error: unknown;
    try {
      sf(["project", "deploy", "validate"]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SfError);
    expect(error).toMatchObject({ message: "Failed", sfName: "FailedValidationError", data: { deployId: DEPLOY_ID } });
  });
});
