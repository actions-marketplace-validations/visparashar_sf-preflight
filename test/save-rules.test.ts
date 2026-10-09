// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, loadProject, saveProcedure } from "../src/core/index.js";
import { parseApprovalProcess, parseDuplicateRule, parseRuleSet } from "../src/core/parsers/saveRules.js";
import { classifyPath } from "../src/core/project.js";
import type { Change, Finding } from "../src/core/types.js";

const base = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const assignment = (active: boolean) =>
  `<AssignmentRules ${NS}><assignmentRule><fullName>Standard</fullName><active>${active}</active><ruleEntry><assignedTo>Support</assignedTo><assignedToType>Queue</assignedToType><criteriaItems><field>Case.Origin</field><operation>equals</operation><value>Web</value></criteriaItems></ruleEntry><ruleEntry><formula>ISPICKVAL(Priority, "High")</formula></ruleEntry></assignmentRule></AssignmentRules>`;
const duplicate = (active: boolean, action: "Block" | "Allow") =>
  `<DuplicateRule ${NS}><actionOnInsert>${action}</actionOnInsert><actionOnUpdate>Allow</actionOnUpdate><isActive>${active}</isActive><masterLabel>Std</masterLabel><duplicateRuleMatchRules><matchingRule>Account_Match</matchingRule></duplicateRuleMatchRules></DuplicateRule>`;
const matching = `<MatchingRules ${NS}><matchingRules><fullName>Account_Match</fullName><ruleStatus>Active</ruleStatus><matchingRuleItems><fieldName>Name</fieldName><matchingMethod>Exact</matchingMethod></matchingRuleItems><matchingRuleItems><fieldName>Tax_Id__c</fieldName></matchingRuleItems></matchingRules></MatchingRules>`;

describe("save rule parsing", () => {
  it("reads rule sets with their criteria fields, from items and formulas", () => {
    const [r] = parseRuleSet(assignment(true), "Case", "f");
    expect(r).toMatchObject({ kind: "AssignmentRule", name: "Case.Standard", object: "Case", active: true });
    expect(r?.fields).toEqual(["Origin", "Priority"]);
  });

  it("reads what a duplicate rule blocks and an approval process's actions", () => {
    expect(parseDuplicateRule(duplicate(true, "Block"), "Account.Std", "Account", "f")).toMatchObject({
      blocks: { insert: true, update: false },
      matchingRules: ["Account_Match"],
    });
    const ap = parseApprovalProcess(
      `<ApprovalProcess ${NS}><active>true</active><entryCriteria><criteriaItems><field>Opportunity.Discount__c</field></criteriaItems></entryCriteria><finalApprovalActions><action><name>Set_Approved</name><type>FieldUpdate</type></action></finalApprovalActions><recordEditability>AdminOnly</recordEditability></ApprovalProcess>`,
      "Opportunity.Discount",
      "Opportunity",
      "f",
    );
    expect(ap).toMatchObject({
      fields: ["Discount__c"],
      recordEditability: "AdminOnly",
      actions: ["FieldUpdate Set_Approved"],
    });
  });
});

describe("save rules in the analysis", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const run = (changes: Change[], readBase?: (f: string) => string | undefined): Finding[] =>
    analyze({ model: loadProject(dir, { cache: false }), changes, readBase }).findings;
  const modified = (rel: string): Change => ({ changeType: "modified", component: classifyPath(base + rel) });
  const byRule = (fs: Finding[], rule: string) => fs.filter((f) => f.rule === rule);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-save-rules-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("objects/Case/fields/Origin.field-meta.xml", "<CustomField><fullName>Origin</fullName></CustomField>");
    write(
      "objects/Account/fields/Tax_Id__c.field-meta.xml",
      "<CustomField><fullName>Tax_Id__c</fullName><type>Text</type></CustomField>",
    );
    write("assignmentRules/Case.assignmentRules-meta.xml", assignment(true));
    write("matchingRules/Account.matchingRule-meta.xml", matching);
    write("duplicateRules/Account.Std.duplicateRule-meta.xml", duplicate(true, "Block"));
    write(
      "classes/AccountImporter.cls",
      "public class AccountImporter { public static void run(){ insert new Account(Name='x', Tax_Id__c='1'); } }",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("puts duplicate and assignment rules in the order of execution", () => {
    const model = loadProject(dir, { cache: false });
    const acct = saveProcedure(model, "Account", "insert");
    expect(acct.steps.map((s) => [s.phaseLabel, s.automation.name, s.notes[0]])).toContainEqual([
      "Duplicate rule",
      "Account.Std",
      "blocks the save when a duplicate is found",
    ]);
    expect(acct.steps.find((s) => s.phase === "duplicate")?.notes[1]).toBe("matches on Name, Tax_Id__c");
    expect(saveProcedure(model, "Account", "update").steps.find((s) => s.phase === "duplicate")?.notes[0]).toBe(
      "alerts on duplicates, allows the save",
    );
    expect(saveProcedure(model, "Case", "insert").steps.map((s) => s.phase)).toContain("assignment");
    expect(saveProcedure(model, "Case", "delete").steps.map((s) => s.phase)).not.toContain("assignment");
  });

  it("lists save rules among a field's references, so deleting the field is caught", () => {
    const fs = run([
      { changeType: "deleted", component: classifyPath(`${base}objects/Account/fields/Tax_Id__c.field-meta.xml`) },
    ]);
    expect(byRule(fs, "deleted-still-referenced")[0]?.detail).toContain("DuplicateRule Account.Std");
  });

  it("warns when a changed duplicate rule now blocks saves that automation makes", () => {
    const fs = run([modified("duplicateRules/Account.Std.duplicateRule-meta.xml")], () => duplicate(true, "Allow"));
    const [f] = byRule(fs, "automated-write-vs-duplicate-rule");
    expect(f?.severity).toBe("high");
    expect(f?.title).toBe("Duplicate rule Account.Std now blocks insert of Account records it matches");
    expect(f?.detail).toContain("class AccountImporter");
    expect(f?.detail).toContain("Name, Tax_Id__c");
  });

  it("warns when a change's automation inserts records a duplicate rule blocks", () => {
    const fs = run([modified("classes/AccountImporter.cls")]);
    expect(byRule(fs, "automated-write-vs-duplicate-rule")[0]?.title).toBe(
      "Automated writes to Account can be blocked by 1 duplicate rule(s)",
    );
  });

  it("reports rules switched on or off", () => {
    const fs = run([modified("assignmentRules/Case.assignmentRules-meta.xml")], () => assignment(false));
    expect(byRule(fs, "save-rule-changed").map((f) => [f.severity, f.title])).toEqual([
      ["medium", "Assignment rule Case.Standard switched on"],
    ]);
  });

  it("treats platform events as a contract, and stops the cascade at them", () => {
    write("objects/Order_Shipped__e/Order_Shipped__e.object-meta.xml", "<CustomObject/>");
    write(
      "objects/Order_Shipped__e/fields/Tracking__c.field-meta.xml",
      "<CustomField><fullName>Tracking__c</fullName></CustomField>",
    );
    write(
      "classes/Shipper.cls",
      "public class Shipper { public static void ship(){ EventBus.publish(new Order_Shipped__e(Tracking__c='1')); } }",
    );
    write(
      "triggers/ShippedSub.trigger",
      "trigger ShippedSub on Order_Shipped__e (after insert) { update new Account(Name='x'); }",
    );
    write(
      "flows/On_Shipped.flow-meta.xml",
      `<Flow ${NS}><status>Active</status><processType>AutoLaunchedFlow</processType><start><object>Order_Shipped__e</object><triggerType>PlatformEvent</triggerType></start></Flow>`,
    );
    write(
      "lwc/shipTracker/shipTracker.js",
      "import { subscribe } from 'lightning/empApi'; const CH = '/event/Order_Shipped__e';",
    );
    const fs = run([
      {
        changeType: "deleted",
        component: classifyPath(`${base}objects/Order_Shipped__e/fields/Tracking__c.field-meta.xml`),
      },
    ]);
    const [f] = byRule(fs, "platform-event-contract");
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("Published by class Shipper");
    expect(f?.detail).toContain("trigger ShippedSub");
    expect(f?.detail).toContain("flow On_Shipped");
    expect(f?.detail).toContain("component shipTracker");
    const proc = saveProcedure(loadProject(dir, { cache: false }), "Order_Shipped__e", "insert");
    expect(proc.steps.map((s) => s.automation.name)).toEqual(["ShippedSub", "On_Shipped"]);
    expect(proc.steps[0]?.notes).toContain("subscriber: runs later, in its own transaction");
  });
});
