// SPDX-License-Identifier: Apache-2.0
import { redactEmails } from "../util.js";
import { orgLabel, orgRef } from "./enrich.js";
import { assertSafeOrg, createSfRunner, field, query, SfError, type SfRunner } from "./sf.js";

/**
 * Runs generated tests in an org as a check-only deployment (`sf project deploy validate`):
 * Salesforce compiles the project and the tests, runs the tests, and rolls everything back.
 * Nothing is saved in the org.
 */

export interface ValidateTestsOptions {
  /** Org alias or username authorized with `sf org login`. */
  org: string;
  /** Absolute SFDX project directory; `sf` runs there. */
  projectDir: string;
  /** Package directories to deploy, relative to the project. */
  sourceDirs: string[];
  /** Directory with the generated tests when it isn't inside a package directory. */
  testsDir?: string;
  /** Generated test class. */
  className: string;
  /** Generated test methods, in order. */
  methods: string[];
  /** Minutes to wait for the deployment (default 33, like `sf`). */
  waitMinutes?: number;
  /** Run in an org that isn't a sandbox, scratch org or Developer Edition org. */
  allowProduction?: boolean;
  runner?: SfRunner;
}

export type OrgKind = "sandbox" | "scratch" | "developer" | "production" | "unknown";

export interface TestOutcome {
  method: string;
  /** "setup failed": the data factory couldn't create records the org accepts, so nothing was checked. */
  outcome: "pass" | "fail" | "setup failed" | "not run";
  /** Failure message and the first line of the stack trace. */
  message?: string;
  ms?: number;
}

export interface ComponentError {
  type?: string;
  name: string;
  line?: number;
  problem: string;
}

export interface ValidationResult {
  /** How the org is named in reports: its alias, never a username. */
  org: string;
  orgKind: OrgKind;
  status: "passed" | "failed";
  deployId?: string;
  tests: TestOutcome[];
  componentErrors: ComponentError[];
  coverageWarnings: string[];
  /** Why the deployment failed, when the result has no structured details. */
  message?: string;
}

const redact = redactEmails;
const list = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const MAX_MESSAGE = 500;
/** Drop the boilerplate Salesforce wraps around flow errors so the cause fits in the report. */
const tidy = (s: string) =>
  s
    .replace(
      /We can['’]t save this record because the [“"]([^”"]{1,200})[”"] process failed\. Give your Salesforce admin these details\. ?/g,
      "Flow “$1” failed. ",
    )
    .replace(/ ?You can look up ExceptionCode values in the SOAP API Developer Guide\.?/g, "")
    .replace(/ ?Error ID: [0-9-]{6,40}(?: \([-0-9]{1,20}\))?/g, "");
const clip = (s: string) => {
  const t = tidy(s);
  return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE - 1)}…` : t;
};

/** Sandbox, scratch org, Developer Edition or production, from the Organization record. */
export function orgKind(run: SfRunner, org: string): OrgKind {
  try {
    const [rec] = query(run, org, "SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1");
    if (!rec) return "unknown";
    if (field(rec, "IsSandbox") === true) return "sandbox";
    if (field(rec, "TrialExpirationDate")) return "scratch";
    if (field(rec, "OrganizationType") === "Developer Edition") return "developer";
    return "production";
  } catch {
    return "unknown";
  }
}

interface TestEntry {
  name?: string;
  methodName?: string;
  message?: string;
  stackTrace?: string;
  time?: string | number;
}

interface DeployResponse {
  id?: string;
  status?: string;
  success?: boolean;
  errorMessage?: string;
  details?: {
    componentFailures?: unknown;
    runTestResult?: { successes?: unknown; failures?: unknown; codeCoverageWarnings?: unknown };
  };
}

/** The generated data factory throws PreflightException when the org rejects its records. */
const failureKind = (message: string): "fail" | "setup failed" =>
  /^[\w.]*PreflightException:/.test(message.trim()) ? "setup failed" : "fail";

/** Turn a deploy result from `sf project deploy validate|report --json` into test outcomes. */
export function readDeployResult(
  response: DeployResponse,
  className: string,
  methods: string[],
): Omit<ValidationResult, "org" | "orgKind"> {
  const ours = (e: TestEntry) => (e.name ?? "").toLowerCase() === className.toLowerCase();
  const rtr = response.details?.runTestResult;
  const successes = list(rtr?.successes as TestEntry | TestEntry[]).filter(ours);
  const failures = list(rtr?.failures as TestEntry | TestEntry[]).filter(ours);
  const ms = (e: TestEntry) => {
    const n = Number(e.time);
    return Number.isFinite(n) ? n : undefined;
  };
  const byMethod = new Map<string, TestOutcome>();
  for (const s of successes) {
    if (s.methodName) byMethod.set(s.methodName.toLowerCase(), { method: s.methodName, outcome: "pass", ms: ms(s) });
  }
  for (const f of failures) {
    if (!f.methodName) continue;
    const trace = (f.stackTrace ?? "").split("\n")[0]?.trim();
    const message = clip(redact([f.message?.trim(), trace ? `(${trace})` : ""].filter(Boolean).join(" ")));
    const outcome = failureKind(f.message ?? "");
    byMethod.set(f.methodName.toLowerCase(), { method: f.methodName, outcome, message, ms: ms(f) });
  }
  const tests = methods.map((m) => byMethod.get(m.toLowerCase()) ?? { method: m, outcome: "not run" as const });

  const componentErrors = list(
    response.details?.componentFailures as
      | {
          componentType?: string;
          fullName?: string;
          lineNumber?: string | number;
          problem?: string;
          problemType?: string;
        }
      | undefined,
  )
    .filter((c) => (c.problemType ?? "Error") === "Error")
    .map((c) => {
      const line = Number(c.lineNumber);
      return {
        type: c.componentType || undefined,
        name: c.fullName ?? "(unknown)",
        line: Number.isFinite(line) && line > 0 ? line : undefined,
        problem: clip(redact(c.problem ?? "")),
      };
    });
  const coverageWarnings = list(rtr?.codeCoverageWarnings as { name?: string; message?: string } | undefined).map((w) =>
    clip(redact(`${w.name ? `${w.name}: ` : ""}${w.message ?? ""}`)),
  );
  const failed = !response.success || tests.some((t) => t.outcome !== "pass") || componentErrors.length > 0;
  return {
    status: failed ? "failed" : "passed",
    deployId: response.id,
    tests,
    componentErrors,
    coverageWarnings,
    message:
      failed && !componentErrors.length && !failures.length && response.errorMessage
        ? clip(redact(response.errorMessage))
        : undefined,
  };
}

/** Outcomes from the message of a failed validation, when the full result can't be read. */
export function readFailureMessage(
  message: string,
  className: string,
  methods: string[],
): Pick<ValidationResult, "tests" | "message"> {
  const failed = new Map<string, string>();
  for (const line of message.split("\n")) {
    const m = /^\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+) - (.*)$/.exec(line);
    if (m && m[1]!.toLowerCase() === className.toLowerCase()) failed.set(m[2]!.toLowerCase(), clip(redact(m[3]!)));
  }
  return {
    tests: methods.map((method) => {
      const msg = failed.get(method.toLowerCase());
      return msg !== undefined ? { method, outcome: failureKind(msg), message: msg } : { method, outcome: "not run" };
    }),
    message: clip(redact(message)),
  };
}

/** Deploy the project and the generated tests check-only, run the tests, and report each one. */
export function validateTests(opts: ValidateTestsOptions): ValidationResult {
  const org = assertSafeOrg(opts.org);
  const wait = opts.waitMinutes ?? 33;
  if (!Number.isInteger(wait) || wait < 1 || wait > 600) throw new SfError("--wait must be between 1 and 600 minutes.");
  const run = opts.runner ?? createSfRunner({ cwd: opts.projectDir, timeoutMs: (wait + 5) * 60_000 });

  let alias: unknown;
  try {
    alias = (run(["org", "display", "--target-org", org]) as { alias?: unknown } | undefined)?.alias;
  } catch (err) {
    throw new SfError(`Could not use org "${org}": ${redact((err as Error).message)}`);
  }
  const label = orgLabel(org, alias);
  const kind = orgKind(run, org);
  if ((kind === "production" || kind === "unknown") && !opts.allowProduction) {
    throw new SfError(
      kind === "production"
        ? `${orgRef(label)} is a production org. Run generated tests in a sandbox, scratch org or Developer Edition org, or pass --allow-production (the deployment is check-only either way).`
        : `Couldn't tell whether ${orgRef(label)} is a sandbox. Pass --allow-production to run the check-only deployment anyway.`,
    );
  }

  const args = ["project", "deploy", "validate"];
  for (const d of opts.sourceDirs) args.push("--source-dir", d);
  if (opts.testsDir) args.push("--source-dir", opts.testsDir);
  args.push(
    "--test-level",
    "RunSpecifiedTests",
    "--tests",
    opts.className,
    "--target-org",
    org,
    "--wait",
    String(wait),
    "--concise",
  );

  let response: DeployResponse | undefined;
  let failure: SfError | undefined;
  try {
    response = run(args) as DeployResponse;
  } catch (err) {
    if (!(err instanceof SfError)) throw err;
    const deployId = (err.data as { deployId?: unknown } | undefined)?.deployId;
    if (typeof deployId !== "string" || !/^0Af[A-Za-z0-9]{12,15}$/.test(deployId)) {
      throw new SfError(`Validation in ${orgRef(label)} failed: ${redact(err.message)}`);
    }
    failure = err;
    try {
      response = run(["project", "deploy", "report", "--job-id", deployId, "--target-org", org]) as DeployResponse;
    } catch {
      response = undefined;
    }
    if (!response?.details) {
      return {
        org: label,
        orgKind: kind,
        status: "failed",
        deployId,
        componentErrors: [],
        coverageWarnings: [],
        ...readFailureMessage(err.message, opts.className, opts.methods),
      };
    }
  }
  const read = readDeployResult(response ?? {}, opts.className, opts.methods);
  if (failure && read.status === "passed") read.status = "failed";
  return { org: label, orgKind: kind, ...read };
}

const OUTCOME = {
  pass: "✅ pass",
  fail: "❌ fail",
  "setup failed": "⚠️ setup failed",
  "not run": "⏭️ not run",
} as const;
const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const seconds = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);

/** Markdown section with the outcome of each generated test. */
export function validationToMarkdown(v: ValidationResult): string {
  const out: string[] = [`### Run in ${orgRef(v.org)}`, ""];
  const passed = v.tests.filter((t) => t.outcome === "pass").length;
  const failed = v.tests.filter((t) => t.outcome === "fail").length;
  const setup = v.tests.filter((t) => t.outcome === "setup failed").length;
  const setupNote = setup ? `${setup} couldn't create their test data in this org` : "";
  const coverageOnly =
    v.status === "failed" &&
    !v.componentErrors.length &&
    v.coverageWarnings.length > 0 &&
    v.tests.every((t) => t.outcome === "pass");
  const headline =
    v.status === "passed"
      ? `✅ All ${v.tests.length} tests passed.`
      : coverageOnly
        ? `❌ All ${v.tests.length} tests passed, but Salesforce rejected the deployment on code coverage: with RunSpecifiedTests, each Apex class and trigger in the deployment needs 75% coverage from the tests that ran.`
        : v.componentErrors.length
          ? `❌ The deployment has ${v.componentErrors.length} component error(s); ${passed ? `${passed} test(s) passed` : "no tests ran"}.`
          : failed
            ? `❌ ${failed} of ${v.tests.length} tests failed${setup ? `, and ${setupNote}` : ""}.`
            : setup
              ? `⚠️ ${setup} of ${v.tests.length} tests couldn't create their test data in this org; the others passed.`
              : "❌ The validation failed.";
  const ran = v.tests.some((t) => t.outcome !== "not run");
  out.push(
    ran
      ? `${headline} Check-only deployment: Salesforce compiled and ran everything, then rolled it back, so nothing was saved in the org.`
      : `${headline} Check-only deployment: nothing was saved in the org.`,
    "",
  );
  if (v.componentErrors.length) {
    out.push("| Component | Line | Problem |", "|---|---|---|");
    for (const c of v.componentErrors) {
      out.push(`| ${cell(c.type ? `${c.type} ${c.name}` : c.name)} | ${c.line ?? ""} | ${cell(c.problem)} |`);
    }
    out.push("");
  }
  if (v.tests.some((t) => t.outcome !== "not run") || !v.componentErrors.length) {
    out.push("| Test | Result | Details |", "|---|---|---|");
    for (const t of v.tests) {
      out.push(`| \`${t.method}\` | ${OUTCOME[t.outcome]} | ${cell(t.message ?? seconds(t.ms))} |`);
    }
    out.push("");
  }
  if (v.message) out.push("```", v.message, "```", "");
  if (coverageOnly) {
    for (const w of v.coverageWarnings.slice(0, 10)) out.push(`- ${w}`);
    if (v.coverageWarnings.length > 10) out.push(`- and ${v.coverageWarnings.length - 10} more`);
    out.push("");
  } else if (v.coverageWarnings.length) {
    out.push(
      `Salesforce also reported ${v.coverageWarnings.length} code coverage warning(s), because only the generated tests ran.`,
      "",
    );
  }
  if (failed) {
    out.push(
      "A failed test points at a real risk (the assertion or exception says which) or at values this org rejects; the NOTE comments in the test class say which values to adjust.",
      "",
    );
  }
  if (setup) {
    out.push(
      "A test whose setup failed stopped before checking anything: the data factory couldn't create records this org accepts. The message names the object and the error; set the missing values in that test's map, and please report it if the factory should have handled it.",
      "",
    );
  }
  if (v.deployId) out.push(`Deployment ID: \`${v.deployId}\``);
  return out.join("\n").trimEnd();
}
