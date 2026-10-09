// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  type AuditEntry,
  alertFromMonitor,
  classifyAudit,
  monitorShouldNotify,
  monitorToMarkdown,
  payloadFor,
  runMonitor,
} from "../src/core/index.js";
import type { SfRunner } from "../src/core/org/sf.js";

const e = (
  display: string,
  section = "Customize",
  user = "Pat Admin",
  date = "2026-10-09T10:00:00.000+0000",
): AuditEntry => ({
  action: "x",
  section,
  display,
  createdDate: date,
  user,
});

function runnerFor(rows: Record<string, unknown>[], seen: string[] = []): SfRunner {
  return (args) => {
    seen.push(args[args.indexOf("--query") + 1] ?? "");
    return { records: rows.map((r) => ({ attributes: {}, ...r })) };
  };
}

describe("classifyAudit", () => {
  it("ranks risky changes and ignores the rest", () => {
    const { findings } = classifyAudit([
      e("Changed validation rule Require_Close_Date: made inactive"),
      e("Activated flow Opportunity_Followup"),
      e("Changed profile layout assignment"),
      e("Granted Modify All Data to permission set Ops"),
      e("Logged in as a user"),
    ]);
    expect(findings.map((f) => f.rule)).toEqual([
      "validation-deactivated",
      "broad-permission",
      "flow-activated",
      "access-changed",
    ]);
    expect(findings.map((f) => f.severity)).toEqual(["high", "high", "medium", "medium"]);
  });

  it("leaves the wording out of permission assignments, which name a person", () => {
    const { findings } = classifyAudit([e("Assigned permission set Sales_Ops to user jane.doe@example.com")]);
    expect(findings[0]?.rule).toBe("permission-assigned");
    expect(findings[0]?.detail).toBe("");
  });

  it("removes email addresses and control characters from wording", () => {
    const { findings } = classifyAudit([e("Deactivated flow Foo‮ by sam@example.com")]);
    expect(findings[0]?.detail).not.toContain("sam@example.com");
    expect(findings[0]?.detail).not.toContain("‮");
  });

  it("skips ignored users without showing them", () => {
    const { findings, skipped } = classifyAudit([e("Deactivated flow Foo", "Flows", "CI Deploy User")], {
      ignoreUsers: ["ci deploy user"],
    });
    expect(findings).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe("runMonitor", () => {
  const rows = [
    {
      Action: "a",
      Section: "Validation Rules",
      Display: "Changed validation rule Foo_Rule: made inactive",
      CreatedDate: "2026-10-09T11:00:00.000+0000",
    },
    { Action: "b", Section: "Other", Display: "Something harmless", CreatedDate: "2026-10-09T10:00:00.000+0000" },
  ];

  it("queries read-only, without the user column unless users are ignored", () => {
    const seen: string[] = [];
    const report = runMonitor({ org: "prod", since: new Date("2026-10-09T00:00:00Z"), run: runnerFor(rows, seen) });
    expect(seen[0]).toMatch(
      /^SELECT Action, Section, Display, CreatedDate FROM SetupAuditTrail WHERE CreatedDate >= 2026-10-09T00:00:00Z/,
    );
    expect(seen[0]).not.toContain("CreatedBy");
    expect(report.risk).toBe("high");
    expect(report.scanned).toBe(2);
    expect(report.newest).toBe("2026-10-09T11:00:00.000+0000");
    const withUser: string[] = [];
    runMonitor({ org: "prod", since: new Date(), exclusive: true, ignoreUsers: ["x"], run: runnerFor([], withUser) });
    expect(withUser[0]).toContain("CreatedBy.Name");
    expect(withUser[0]).toContain("CreatedDate >");
    expect(withUser[0]).not.toContain("CreatedDate >=");
  });

  it("refuses an unsafe org alias", () => {
    expect(() => runMonitor({ org: "prod; rm -rf", since: new Date(), run: runnerFor([]) })).toThrow(/Invalid org/);
  });

  it("never puts a user name in the report, markdown or alert", () => {
    const report = runMonitor({
      org: "prod",
      since: new Date(),
      ignoreUsers: ["Other Person"],
      run: runnerFor(rows.map((r) => ({ ...r, CreatedBy: { Name: "Pat Admin" } }))),
    });
    const all = JSON.stringify([report, monitorToMarkdown(report), payloadFor("slack", alertFromMonitor(report))]);
    expect(all).not.toContain("Pat Admin");
  });

  it("is quiet when nothing risky happened", () => {
    const report = runMonitor({ org: "prod", since: new Date(), run: runnerFor([rows[1]!]) });
    expect(report.risk).toBe("low");
    expect(monitorShouldNotify(report, "medium")).toBe(false);
    expect(monitorToMarkdown(report)).toContain("No risky setup changes");
  });
});

describe("alertFromMonitor", () => {
  it("builds a short, safe alert", () => {
    const report = runMonitor({
      org: "prod",
      since: new Date(),
      run: runnerFor([
        {
          Action: "a",
          Section: "Flows",
          Display: "Deactivated flow *bold* <!channel>",
          CreatedDate: "2026-10-09T11:00:00.000+0000",
        },
      ]),
    });
    const alert = alertFromMonitor(report, { link: { label: "Open", url: "https://example.com/run/1" } });
    expect(alert.risk).toBe("high");
    expect(alert.items).toHaveLength(1);
    expect(JSON.stringify(payloadFor("slack", alert))).not.toContain("<!channel>");
    expect(monitorShouldNotify(report, "high")).toBe(true);
  });
});
