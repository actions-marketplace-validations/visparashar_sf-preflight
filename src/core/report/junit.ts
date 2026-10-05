// SPDX-License-Identifier: Apache-2.0
import type { FailOn } from "../config.js";
import type { AnalysisResult, Severity } from "../types.js";

/**
 * JUnit XML, which GitLab, Azure DevOps, Jenkins, Bitbucket and most CI systems show as test
 * results: one test case per gate check, and one per finding (failed when at or above the
 * threshold).
 */

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 forbids these characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

export function toJunit(result: AnalysisResult, failOn: FailOn = result.gate?.failOn ?? "high"): string {
  const suites: string[] = [];
  let tests = 0;
  let failures = 0;

  if (result.gate) {
    const cases = result.gate.checks.map((c) => {
      tests++;
      if (c.status === "fail") failures++;
      return `    <testcase classname="sf-preflight.gate" name="${xml(c.label)}">${
        c.status === "fail" ? `\n      <failure message="${xml(c.detail)}" type="gate"/>\n    ` : ""
      }</testcase>`;
    });
    const f = result.gate.checks.filter((c) => c.status === "fail").length;
    suites.push(
      `  <testsuite name="sf-preflight.gate" tests="${cases.length}" failures="${f}">\n${cases.join("\n")}\n  </testsuite>`,
    );
  }

  const blocking = (s: Severity) => failOn !== "none" && RANK[s] >= RANK[failOn as Severity];
  const findingCases = result.findings.map((f) => {
    tests++;
    const fails = blocking(f.severity);
    if (fails) failures++;
    const file = f.files[0] ? ` file="${xml(f.files[0])}"` : "";
    return `    <testcase classname="sf-preflight.${xml(f.rule)}" name="${xml(`[${f.severity}] ${f.title}`)}"${file}>${
      fails
        ? `\n      <failure message="${xml(f.title)}" type="${f.severity}">${xml(f.detail)}</failure>\n    `
        : `\n      <system-out>${xml(`${f.severity}: ${f.detail}`)}</system-out>\n    `
    }</testcase>`;
  });
  if (!findingCases.length) {
    tests++;
    findingCases.push(`    <testcase classname="sf-preflight.findings" name="No findings"></testcase>`);
  }
  const ff = result.findings.filter((f) => blocking(f.severity)).length;
  suites.push(
    `  <testsuite name="sf-preflight.findings" tests="${findingCases.length}" failures="${ff}">\n${findingCases.join("\n")}\n  </testsuite>`,
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="sf-preflight" tests="${tests}" failures="${failures}">`,
    ...suites,
    `</testsuites>`,
  ].join("\n");
}
