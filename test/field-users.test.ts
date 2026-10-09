// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeFields, qualify } from "../src/core/fieldUsers.js";
import { analyze, loadProject } from "../src/core/index.js";
import { classifyPath } from "../src/core/project.js";
import type { Change, Finding } from "../src/core/types.js";

const base = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("field tokens", () => {
  it("reads report, report type and merge field notations", () => {
    expect(qualify("Contact$Email")).toBe("Contact.Email");
    expect(qualify("Opportunity$Account.Tier__c")).toBe("Account.Tier__c");
    expect(qualify("Invoice__c.Customer__r.Rating__c")).toBe("Customer__c.Rating__c");
    expect(qualify("Total__c", "Invoice__c")).toBe("Invoice__c.Total__c");
    expect(mergeFields("Dear {!Contact.FirstName}, {{{Opportunity.Total__c}}} {!$User.Email}")).toEqual([
      "Contact.FirstName",
      "Opportunity.Total__c",
    ]);
  });
});

describe("reports, list views, templates and the like as field references", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const run = (changes: Change[]): Finding[] =>
    analyze({ model: loadProject(dir, { cache: false }), changes }).findings;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-field-users-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(
      "objects/Opportunity/fields/Total__c.field-meta.xml",
      "<CustomField><fullName>Total__c</fullName></CustomField>",
    );
    write(
      "reports/Sales/Pipeline.report-meta.xml",
      `<Report ${NS}><columns><field>Opportunity$Total__c</field></columns><reportType>Opps__c</reportType></Report>`,
    );
    write(
      "reportTypes/Opps.reportType-meta.xml",
      `<ReportType ${NS}><baseObject>Opportunity</baseObject><sections><columns><field>Total__c</field><table>Opportunity</table></columns></sections></ReportType>`,
    );
    write(
      "objects/Opportunity/listViews/Big.listView-meta.xml",
      `<ListView ${NS}><columns>OPPORTUNITY.NAME</columns><columns>Total__c</columns></ListView>`,
    );
    write(
      "objects/Opportunity/fieldSets/Key.fieldSet-meta.xml",
      `<FieldSet ${NS}><displayedFields><field>Total__c</field></displayedFields></FieldSet>`,
    );
    write(
      "objects/Opportunity/compactLayouts/Compact.compactLayout-meta.xml",
      `<CompactLayout ${NS}><fields>Name</fields><fields>Total__c</fields></CompactLayout>`,
    );
    write(
      "quickActions/Opportunity.Quick_Update.quickAction-meta.xml",
      `<QuickAction ${NS}><quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>Total__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout><type>Update</type></QuickAction>`,
    );
    write("email/Sales/Thanks.email", "Thanks! Your total is {!Opportunity.Total__c}.");
    write("email/Sales/Thanks.email-meta.xml", `<EmailTemplate ${NS}><name>Thanks</name></EmailTemplate>`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists every one of them when the field is deleted", () => {
    const fs = run([
      { changeType: "deleted", component: classifyPath(`${base}objects/Opportunity/fields/Total__c.field-meta.xml`) },
    ]);
    const detail = fs.find((f) => f.rule === "deleted-still-referenced")?.detail ?? "";
    for (const s of [
      "Report Sales/Pipeline",
      "ReportType Opps",
      "ListView Opportunity.Big",
      "FieldSet Opportunity.Key",
      "CompactLayout Opportunity.Compact",
      "QuickAction Opportunity.Quick_Update",
      "EmailTemplate Sales/Thanks",
    ])
      expect(detail).toContain(s);
  });

  it("flags a changed one that names a field the project's object lacks", () => {
    write(
      "reports/Sales/Pipeline.report-meta.xml",
      `<Report ${NS}><columns><field>Opportunity.Discount__c</field></columns><reportType>Opportunity</reportType></Report>`,
    );
    const [f] = run([
      { changeType: "modified", component: classifyPath(`${base}reports/Sales/Pipeline.report-meta.xml`) },
    ]).filter((x) => x.rule === "missing-field-reference");
    expect(f?.title).toBe("Report Sales/Pipeline names 1 field(s) the project does not have");
    expect(f?.detail).toContain("Opportunity.Discount__c");
  });
});
