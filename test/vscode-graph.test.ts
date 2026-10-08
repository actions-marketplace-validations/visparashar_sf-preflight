// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";
import type { AnalysisResult } from "../src/core/types.js";
import { graphOf, MAX_GRAPH_NODES } from "../vscode/src/graph.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const at = (rel: string) => path.join(FIXTURE, SRC, rel);
const analyze = (...files: string[]) =>
  analyzeChange({ projectDir: FIXTURE, files: files.map(at), config: false }).result;
const byLabel = (g: ReturnType<typeof graphOf>, label: string) => g.nodes.find((n) => n.label === label)!;

describe("the blast-radius graph", () => {
  it("centres on a single change and rings what it sets off by distance", () => {
    const g = graphOf(analyze("classes/ContactTriggerHandler.cls"));
    expect(g.center).toBe(`f:${SRC}/classes/ContactTriggerHandler.cls`);
    const center = g.nodes.find((n) => n.id === g.center)!;
    expect(center).toMatchObject({ depth: 0, changed: true, kind: "ApexClass", severity: "high" });
    // The class reaches its trigger, which runs on Contact and writes Account.
    expect(byLabel(g, "ContactTrigger")).toMatchObject({ kind: "ApexTrigger", depth: 1, detail: "After trigger" });
    expect(byLabel(g, "Contact")).toMatchObject({ kind: "Object", depth: 2 });
    expect(byLabel(g, "Account")).toMatchObject({ kind: "Object", depth: 2 });
    expect(byLabel(g, "Account_Sync_Tier_To_Contacts")).toMatchObject({ depth: 3, severity: "high" });
    // The validation rule the trigger's writes must pass is a collision (medium).
    expect(byLabel(g, "Tier_Required_For_Customers")).toMatchObject({ kind: "ValidationRule", severity: "medium" });
    // The flow writing back to Contact closes the cycle.
    const recursion = g.edges.filter((e) => e.recursion);
    expect(recursion).toEqual([
      {
        from: `f:${SRC}/flows/Account_Sync_Tier_To_Contacts.flow-meta.xml`,
        to: "o:Contact",
        kind: "writes",
        recursion: true,
      },
    ]);
    // Every edge joins drawn nodes, and nodes keep their files to open.
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(byLabel(g, "ContactTrigger").file).toBe(at("triggers/ContactTrigger.trigger"));
    expect(g.omitted).toBe(0);
  });

  it("shows what references a changed field and the agent actions it reaches", () => {
    const g = graphOf(analyze("objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml"));
    expect(g.nodes.find((n) => n.id === g.center)).toMatchObject({ kind: "Field", changed: true });
    expect(byLabel(g, "Opportunity")).toMatchObject({ depth: 1 });
    expect(byLabel(g, "Require_Contract_Signed_Date")).toMatchObject({ kind: "ValidationRule", depth: 1 });
    expect(byLabel(g, "Agent_Runtime_User")).toMatchObject({ kind: "PermissionSet", depth: 1 });
    const action = byLabel(g, "Close Opportunity");
    expect(action).toMatchObject({ kind: "AgentAction", depth: 1, detail: "Sales Agent · Close_Deals" });
    // The class the action runs, and the agent's own files, hang off the action.
    for (const label of ["OpportunityCloser", "Close_Deals", "Sales_Agent"]) {
      expect(g.edges.some((e) => e.from === action.id && e.to === byLabel(g, label).id)).toBe(true);
      expect(byLabel(g, label).depth).toBe(2);
    }
  });

  it("puts several changes round a hub", () => {
    const g = graphOf(
      analyze(
        "classes/ContactTriggerHandler.cls",
        "objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml",
        "permissionsets/Agent_Runtime_User.permissionset-meta.xml",
      ),
    );
    expect(g.center).toBe("hub");
    expect(byLabel(g, "3 changes")).toMatchObject({ kind: "hub", depth: 0 });
    const changed = g.nodes.filter((n) => n.changed);
    expect(changed).toHaveLength(3);
    expect(changed.every((n) => n.depth === 0)).toBe(true);
    // Distances count from the nearest change, not from the hub.
    expect(byLabel(g, "ContactTrigger").depth).toBe(1);
    expect(byLabel(g, "Opportunity").depth).toBe(1);
    // A permission set isn't wired to the cascade the class starts.
    const perm = changed.find((n) => n.kind === "PermissionSet")!;
    expect(g.edges.some((e) => e.from === perm.id && e.kind === "reaches")).toBe(false);
  });

  it("keeps the nearest and riskiest nodes when there are too many", () => {
    const base = analyze("classes/ContactTriggerHandler.cls");
    const many: AnalysisResult = {
      ...base,
      saveProcedures: [
        ...base.saveProcedures,
        {
          object: "Contact",
          event: "insert",
          steps: Array.from({ length: MAX_GRAPH_NODES + 10 }, (_, i) => ({
            order: i + 1,
            phase: "after-flow" as const,
            phaseLabel: "After-save flow",
            automation: { kind: "Flow" as const, name: `Flow_${i}` },
            writes: [],
            notes: [],
          })),
        },
      ],
    };
    const g = graphOf(many);
    expect(g.nodes).toHaveLength(MAX_GRAPH_NODES);
    expect(g.omitted).toBeGreaterThan(0);
    // The change and its riskiest neighbours are kept.
    expect(g.nodes.some((n) => n.id === g.center)).toBe(true);
    expect(g.nodes.some((n) => n.label === "Account_Sync_Tier_To_Contacts")).toBe(true);
  });

  it("is just the hub when nothing changed", () => {
    const g = graphOf({
      ...analyze("classes/ContactTriggerHandler.cls"),
      changes: [],
      saveProcedures: [],
      cascade: [],
      findings: [],
      references: [],
      agents: [],
    });
    expect(g.nodes.map((n) => n.label)).toEqual(["No changes"]);
    expect(g.edges).toEqual([]);
  });
});
