// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";
import { RULES } from "../src/core/rules.js";
import type { AnalysisResult } from "../src/core/types.js";
import {
  addToHistory,
  dashboardOf,
  type HistoryEntry,
  historyEntryOf,
  MAX_HISTORY,
  OTHER_RULES,
  RISK_FACTORS,
  readHistory,
} from "../vscode/src/dashboard.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const analyze = (...files: string[]) =>
  analyzeChange({ projectDir: FIXTURE, files: files.map((f) => path.join(FIXTURE, SRC, f)), config: false }).result;

describe("the risk dashboard", () => {
  it("puts every rule in exactly one risk factor", () => {
    const placed = [...RISK_FACTORS.flatMap((f) => f.rules), ...OTHER_RULES];
    expect(new Set(placed).size).toBe(placed.length);
    const missing = RULES.map((r) => r.id).filter((id) => !placed.includes(id));
    expect(missing, "add new rules to a factor in vscode/src/dashboard.ts").toEqual([]);
    const unknown = placed.filter((id) => !RULES.some((r) => r.id === id));
    expect(unknown).toEqual([]);
  });

  const result = analyze("objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml");
  const d = dashboardOf(result);
  const factor = (id: string) => d.factors.find((f) => f.id === id)!;

  it("sums the change up as risk factors", () => {
    expect(d.risk).toBe("high");
    expect(d.changed).toBe(1);
    expect(d.sentence).toMatch(/^1 changed component reaches \d+ objects through \d+ automations\./);
    expect(d.sentence).toMatch(/recursion cycle/);
    expect(factor("recursion").count).toBe(
      result.findings.filter((f) => f.rule === "recursion-cycle" || f.rule === "after-save-self-update").length,
    );
    expect(factor("recursion").worst).toBe("high");
    expect(factor("collisions").count).toBeGreaterThan(0);
    expect(factor("agents").worst).toBe("high");
    // Every finding is in one factor, most severe first, with its key back into the result.
    expect(d.factors.reduce((n, f) => n + f.count, 0)).toBe(result.findings.length);
    for (const f of d.factors) {
      for (const x of f.findings) expect(result.findings[x.key]!.title).toBe(x.title);
      const ranks = f.findings.map((x) => ["high", "medium", "low", "info"].indexOf(x.severity));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
    expect(d.counts).toEqual(result.summary.findingsBySeverity);
  });

  it("shows where the risk sits and the gate on findings", () => {
    // The objects on recursion cycles come first, carrying the cycles' severity.
    expect(d.hotspots[0]).toMatchObject({ worst: "high" });
    expect(d.hotspots[0]!.cycles).toBeGreaterThan(0);
    const account = d.hotspots.find((h) => h.object === "Account")!;
    expect(account.cycles).toBe(1);
    expect(d.hotspots.every((h) => h.findings || h.automations || h.cycles)).toBe(true);
    expect(d.hotspots.length).toBeLessThanOrEqual(6);
    expect(d.gate).toMatchObject({ status: "fail", failOn: "high", label: "No findings at or above high" });
    expect(dashboardOf(result, "none").gate.status).toBe("pass");
    expect(d.agents.affected).toBe(result.agents.length);
  });

  it("says when nothing changed", () => {
    const empty = dashboardOf({ ...result, changes: [], findings: [] } as AnalysisResult);
    expect(empty.sentence).toMatch(/No Salesforce metadata changed/);
    expect(empty.factors.every((f) => f.count === 0)).toBe(true);
  });
});

describe("the risk dashboard's history", () => {
  const entry = (high: number, at = "2026-10-10T10:00:00Z"): HistoryEntry => ({
    at,
    risk: high ? "high" : "low",
    high,
    medium: 1,
    low: 0,
    info: 0,
    changed: 1,
  });

  it("adds a run only when the result changes, and keeps the latest", () => {
    let h: HistoryEntry[] = [];
    h = addToHistory(h, entry(2));
    h = addToHistory(h, entry(2, "2026-10-10T10:05:00Z"));
    expect(h).toHaveLength(1);
    h = addToHistory(h, entry(1, "2026-10-10T10:10:00Z"));
    expect(h.map((e) => e.high)).toEqual([2, 1]);
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = addToHistory(h, entry(i % 2 ? 3 : 4));
    expect(h).toHaveLength(MAX_HISTORY);
  });

  it("records an analysis and reads back only well-formed entries", () => {
    const result = analyze("classes/ContactTriggerHandler.cls");
    const e = historyEntryOf(result, "2026-10-10T10:00:00Z");
    expect(e).toMatchObject({ risk: result.summary.risk, high: result.summary.findingsBySeverity.high, changed: 1 });
    expect(readHistory([e, { at: "x", risk: "extreme" }, null, "x", { ...e, high: -1 }])).toEqual([e]);
    expect(readHistory(undefined)).toEqual([]);
  });
});
