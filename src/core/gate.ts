// SPDX-License-Identifier: Apache-2.0
import type { FailOn, GateConfig } from "./config.js";
import type { ValidationResult } from "./org/validate.js";
import type { AnalysisResult, Severity } from "./types.js";

/**
 * The quality gate: one pass/fail decision per change, from the findings and the policy in
 * `.preflight.json`, plus approvals and test results when the pipeline provides them.
 */

export interface Approval {
  /** Reviewer login or name. */
  reviewer: string;
  submittedAt?: string;
}

export type GateCheckId = "findings" | "ai-approvals" | "agent-tests" | "tests-passed";

export interface GateCheck {
  id: GateCheckId;
  label: string;
  status: "pass" | "fail";
  detail: string;
}

export interface GateResult {
  status: "pass" | "fail";
  failOn: FailOn;
  checks: GateCheck[];
}

export interface GateInput {
  result: AnalysisResult;
  config?: GateConfig;
  /** Approvals of the change (e.g. pull request reviews); undefined when unknown. */
  approvals?: Approval[];
  /** Result of running the generated tests (`preflight tests --validate`); undefined when not run. */
  validation?: ValidationResult;
  /** How many tests the change generates, when known (0 means there is nothing to run). */
  testsGenerated?: number;
}

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

export function evaluateGate({ result, config = {}, approvals, validation, testsGenerated }: GateInput): GateResult {
  const failOn: FailOn = config.failOn ?? "high";
  const checks: GateCheck[] = [];

  const blocking = failOn === "none" ? [] : result.findings.filter((f) => RANK[f.severity] >= RANK[failOn as Severity]);
  const counts = (["high", "medium", "low"] as const)
    .map((s) => [s, blocking.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  checks.push({
    id: "findings",
    label: failOn === "none" ? "Findings (not gated)" : `No findings at or above ${failOn}`,
    status: blocking.length ? "fail" : "pass",
    detail: blocking.length
      ? `${counts.join(", ")}: ${blocking
          .slice(0, 3)
          .map((f) => f.title)
          .join("; ")}${blocking.length > 3 ? "; …" : ""}`
      : failOn === "none"
        ? `${result.findings.length} finding(s); fail-on is none.`
        : `${result.findings.length} finding(s), none at or above ${failOn}.`,
  });

  const needed = config.aiAssistedApprovals ?? 0;
  if (needed > 0) {
    const ai = result.provenance?.aiAssistedCommits ?? 0;
    const label = `AI-assisted changes approved by ${needed} reviewer${needed === 1 ? "" : "s"}`;
    if (!result.provenance) {
      checks.push({ id: "ai-approvals", label, status: "pass", detail: "No commit range was analyzed." });
    } else if (!ai && result.provenance.shallow) {
      checks.push({
        id: "ai-approvals",
        label,
        status: "fail",
        detail:
          "The repository is a shallow clone, so commits may be missing and AI assistance can't be ruled out. Check out with fetch-depth: 0.",
      });
    } else if (!ai) {
      checks.push({ id: "ai-approvals", label, status: "pass", detail: "No AI-assisted commits." });
    } else if (!approvals) {
      checks.push({
        id: "ai-approvals",
        label,
        status: "fail",
        detail: `${ai} AI-assisted commit(s), and no approval data was provided (--approvals).`,
      });
    } else {
      const reviewers = [...new Set(approvals.map((a) => a.reviewer))];
      checks.push({
        id: "ai-approvals",
        label,
        status: reviewers.length >= needed ? "pass" : "fail",
        detail: `${ai} AI-assisted commit(s); ${reviewers.length} approval(s)${reviewers.length ? ` (${reviewers.join(", ")})` : ""}.`,
      });
    }
  }

  if (config.requireAgentTests) {
    const untested = result.agents.filter((a) => !a.tests.length);
    checks.push({
      id: "agent-tests",
      label: "Affected agent actions covered by Testing Center tests",
      status: untested.length ? "fail" : "pass",
      detail: !result.agents.length
        ? "No agent actions affected."
        : untested.length
          ? `Not covered: ${untested.map((a) => `${a.agentLabel ?? a.agent} › ${a.actionLabel ?? a.action}`).join(", ")}.`
          : `${result.agents.length} affected action(s), all covered.`,
    });
  }

  if (config.requireTestsPassed) {
    const label = "Generated tests passed in an org";
    if (!validation && testsGenerated === 0) {
      checks.push({ id: "tests-passed", label, status: "pass", detail: "The change generates no tests to run." });
    } else if (!validation) {
      checks.push({
        id: "tests-passed",
        label,
        status: "fail",
        detail:
          "The generated tests weren't run: run `preflight tests --validate --org <sandbox> --format json` and pass its output with --tests-result.",
      });
    } else {
      const passed = validation.tests.filter((t) => t.outcome === "pass").length;
      checks.push({
        id: "tests-passed",
        label,
        status: validation.status === "passed" ? "pass" : "fail",
        detail: `${passed} of ${validation.tests.length} passed in ${validation.org}${validation.componentErrors.length ? `; ${validation.componentErrors.length} component error(s)` : ""}.`,
      });
    }
  }

  return { status: checks.some((c) => c.status === "fail") ? "fail" : "pass", failOn, checks };
}

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function gateToMarkdown(g: GateResult): string {
  const out = [
    `### Quality gate: ${g.status === "pass" ? "✅ passed" : "❌ failed"}`,
    "",
    "| Check | Result | Details |",
    "|---|---|---|",
    ...g.checks.map((c) => `| ${cell(c.label)} | ${c.status === "pass" ? "✅ pass" : "❌ fail"} | ${cell(c.detail)} |`),
  ];
  return out.join("\n");
}

/** Parse an approvals file: a JSON array of reviewer logins or `{ reviewer, submittedAt }` objects. */
export function parseApprovals(json: unknown, file = "approvals"): Approval[] {
  if (!Array.isArray(json)) throw new Error(`${file}: expected a JSON array of approvals`);
  return json.map((a, i) => {
    if (typeof a === "string" && a.trim()) return { reviewer: a.trim() };
    if (typeof a === "object" && a !== null && typeof (a as Approval).reviewer === "string") {
      const { reviewer, submittedAt } = a as Approval;
      return { reviewer, ...(typeof submittedAt === "string" ? { submittedAt } : {}) };
    }
    throw new Error(`${file}: entry ${i + 1} must be a reviewer name or { "reviewer": "…" }`);
  });
}
