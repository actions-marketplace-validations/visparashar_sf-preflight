// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";
import { isMetadataFile, problemsOf, statusOf, treeOf } from "../vscode/src/model.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const at = (rel: string) => path.join(FIXTURE, SRC, rel);
const analyze = (...files: string[]) =>
  analyzeChange({ projectDir: FIXTURE, files: files.map(at), config: false }).result;

describe("the VS Code extension's view of a report", () => {
  const result = analyze("classes/ContactTriggerHandler.cls");

  it("puts each finding on its files, at its line when known", () => {
    const problems = problemsOf(result);
    const loop = problems.find((p) => p.rule === "dml-or-soql-in-loop")!;
    expect(loop).toMatchObject({ file: at("classes/ContactTriggerHandler.cls"), line: 6, severity: "high" });
    expect(loop.message.split("\n")[0]).toBe(result.findings.find((f) => f.rule === "dml-or-soql-in-loop")!.title);
    // A finding about two files appears on both, each pointing at the other.
    const cycle = problems.filter((p) => p.rule === "recursion-cycle");
    expect(cycle.map((p) => p.file)).toEqual([
      at("triggers/ContactTrigger.trigger"),
      at("flows/Account_Sync_Tier_To_Contacts.flow-meta.xml"),
    ]);
    expect(cycle[0]!.related).toEqual([cycle[1]!.file]);
    expect(cycle.every((p) => p.line === 0)).toBe(true);
    // Below the minimum severity, findings are left out.
    expect(problemsOf(result, "high").every((p) => p.severity === "high")).toBe(true);
    expect(problemsOf(result, "high").some((p) => p.rule === "automated-write-vs-validation-rule")).toBe(false);
  });

  it("builds the blast-radius tree: risk, findings first by severity, changes, what runs", () => {
    const tree = treeOf(result, "vs main");
    expect(tree[0]).toMatchObject({ label: "Risk: high", icon: "error" });
    expect(tree[0]!.description).toBe("vs main · 2 high, 1 medium");
    expect(tree.map((n) => n.label)).toEqual(["Risk: high", "Findings", "Changed components", "What runs", "Cycles"]);
    const findings = tree[1]!.children!;
    expect(findings.map((f) => f.icon)).toEqual(["error", "error", "warning"]);
    expect(findings.find((f) => f.description === "dml-or-soql-in-loop")).toMatchObject({
      file: at("classes/ContactTriggerHandler.cls"),
      line: 6,
    });
    const runs = tree[3]!.children!;
    expect(runs.length).toBe(result.saveProcedures.length);
    expect(runs[0]!.children![0]!.label).toMatch(/^1\. /);
    expect(tree[4]!.children![0]!.label).toContain(" → ");
  });

  it("says when nothing changed", () => {
    const none = { ...result, changes: [], findings: [] };
    expect(treeOf(none).map((n) => n.label)).toEqual(["Risk: high", "No Salesforce metadata changed"]);
  });

  it("summarises every project in the status bar", () => {
    expect(statusOf([])).toMatchObject({ text: "$(shield) Preflight", level: "ok" });
    expect(statusOf([result])).toMatchObject({ text: "$(error) Preflight: 2 high, 1 medium", level: "error" });
    const withCounts = (high: number, medium: number) => ({
      ...result,
      summary: { ...result.summary, findingsBySeverity: { high, medium, low: 0, info: 0 } },
    });
    expect(statusOf([withCounts(0, 1), withCounts(0, 2)])).toMatchObject({
      text: "$(warning) Preflight: 0 high, 3 medium",
      level: "warning",
    });
    expect(statusOf([withCounts(0, 0)]).level).toBe("ok");
    expect(statusOf([{ ...result, changes: [] }]).text).toBe("$(shield) Preflight: no changes");
  });

  it("re-analyzes only for Salesforce metadata", () => {
    for (const f of ["A.cls", "T.trigger", "x.flow-meta.xml", "Agent.agent", "sfdx-project.json", ".preflight.json"]) {
      expect(isMetadataFile(f)).toBe(true);
    }
    for (const f of ["README.md", "jest.config.js", "lwc/c/c.js"]) expect(isMetadataFile(f)).toBe(false);
  });
});
