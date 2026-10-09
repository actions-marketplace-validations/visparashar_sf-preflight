// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSharingRules } from "../src/core/access.js";
import { analyze, loadProject } from "../src/core/index.js";
import { classifyPath } from "../src/core/project.js";
import type { Change, Finding } from "../src/core/types.js";

const base = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const permset = (opts: {
  objects?: [string, string][];
  fields?: string[];
  classes?: string[];
  license?: string;
  root?: string;
  system?: string[];
}) =>
  `<?xml version="1.0"?><${opts.root ?? "PermissionSet"} ${NS}>${(opts.classes ?? [])
    .map((c) => `<classAccesses><apexClass>${c}</apexClass><enabled>true</enabled></classAccesses>`)
    .join("")}${(opts.fields ?? [])
    .map(
      (f) =>
        `<fieldPermissions><field>${f}</field><readable>true</readable><editable>true</editable></fieldPermissions>`,
    )
    .join("")}${(opts.objects ?? [])
    .map(
      ([o, flags]) =>
        `<objectPermissions><object>${o}</object><allowRead>${flags.includes("r")}</allowRead><allowCreate>${flags.includes("c")}</allowCreate><allowEdit>${flags.includes("e")}</allowEdit><allowDelete>${flags.includes("d")}</allowDelete><viewAllRecords>${flags.includes("V")}</viewAllRecords><modifyAllRecords>${flags.includes("M")}</modifyAllRecords></objectPermissions>`,
    )
    .join("")}${(opts.system ?? [])
    .map((u) => `<userPermissions><enabled>true</enabled><name>${u}</name></userPermissions>`)
    .join("")}${opts.license ? `<userLicense>${opts.license}</userLicense>` : ""}</${opts.root ?? "PermissionSet"}>`;

const rules = (...rs: string[]) => `<?xml version="1.0"?><SharingRules ${NS}>${rs.join("")}</SharingRules>`;
const criteria = (name: string, access: string, to: string, field = "Type") =>
  `<sharingCriteriaRules><fullName>${name}</fullName><accessLevel>${access}</accessLevel><label>${name}</label><sharedTo>${to}</sharedTo><criteriaItems><field>${field}</field><operation>equals</operation><value>Customer</value></criteriaItems></sharingCriteriaRules>`;
const guest = (name: string) =>
  `<sharingGuestRules><fullName>${name}</fullName><accessLevel>Read</accessLevel><label>${name}</label><sharedTo><guestUser>Help_Site</guestUser></sharedTo></sharingGuestRules>`;

describe("access changes", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  /** Analyze one modified file against a base version of it. */
  const changed = (rel: string, baseXml: string | undefined): Finding[] => {
    const change: Change = { changeType: "modified", component: classifyPath(base + rel) };
    return analyze({ model: loadProject(dir, { cache: false }), changes: [change], readBase: () => baseXml }).findings;
  };
  const byRule = (fs: Finding[], rule: string) => fs.filter((f) => f.rule === rule);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-access-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(
      "classes/InvoiceCtrl.cls",
      "public with sharing class InvoiceCtrl { @AuraEnabled public static void go(){} }",
    );
    write(
      "lwc/invoiceList/invoiceList.js",
      "import go from '@salesforce/apex/InvoiceCtrl.go'; import AMT from '@salesforce/schema/Invoice__c.Amount__c'; export default class X {}",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports access a permission set takes away, and the components that need it", () => {
    const before = permset({
      objects: [["Invoice__c", "rce"]],
      fields: ["Invoice__c.Amount__c"],
      classes: ["InvoiceCtrl"],
    });
    write("permissionsets/Billing.permissionset-meta.xml", permset({ objects: [["Invoice__c", "r"]] }));
    const [f] = byRule(changed("permissionsets/Billing.permissionset-meta.xml", before), "permission-access-removed");
    expect(f?.severity).toBe("medium");
    expect(f?.title).toBe("Permission set Billing no longer grants 1 object permission, 1 field, 1 Apex class");
    expect(f?.detail).toContain("Invoice__c (create, edit)");
    expect(f?.detail).toContain("LWC invoiceList");
  });

  it("flags a guest profile that gains object or Apex access", () => {
    const before = permset({ root: "Profile", license: "Guest User License" });
    write(
      "profiles/Help Site Profile.profile-meta.xml",
      permset({
        root: "Profile",
        license: "Guest User License",
        objects: [["Invoice__c", "r"]],
        classes: ["InvoiceCtrl"],
      }),
    );
    const [f] = byRule(changed("profiles/Help Site Profile.profile-meta.xml", before), "guest-access");
    expect(f?.severity).toBe("high");
    expect(f?.title).toBe("Guest profile Help Site Profile newly grants access to 1 object and 1 Apex class");
    // A normal profile gaining the same access is not a guest finding.
    write("profiles/Sales.profile-meta.xml", permset({ root: "Profile", objects: [["Invoice__c", "r"]] }));
    expect(byRule(changed("profiles/Sales.profile-meta.xml", permset({ root: "Profile" })), "guest-access")).toEqual(
      [],
    );
  });

  it("rates organization-wide default changes by direction", () => {
    const obj = (internal: string, external = "Private") =>
      `<CustomObject ${NS}><sharingModel>${internal}</sharingModel><externalSharingModel>${external}</externalSharingModel></CustomObject>`;
    write("objects/Invoice__c/Invoice__c.object-meta.xml", obj("ReadWrite"));
    const opened = changed("objects/Invoice__c/Invoice__c.object-meta.xml", obj("Private"));
    expect(byRule(opened, "sharing-model-opened").map((f) => [f.severity, f.title])).toEqual([
      ["high", "Sharing opened up: Invoice__c default access for internal users: Private → Public Read/Write"],
    ]);
    write("objects/Invoice__c/Invoice__c.object-meta.xml", obj("Private"));
    const closed = changed("objects/Invoice__c/Invoice__c.object-meta.xml", obj("Read"));
    expect(byRule(closed, "sharing-model-restricted")[0]?.severity).toBe("medium");
  });

  it("rates sharing rules by audience and access, and notices removals and guest rules", () => {
    expect(
      parseSharingRules(rules(criteria("A", "Edit", "<allInternalUsers></allInternalUsers>")))[0]?.sharedTo,
    ).toEqual({
      type: "allInternalUsers",
    });
    write(
      "sharingRules/Invoice__c.sharingRules-meta.xml",
      rules(
        criteria("All_Edit", "Edit", "<allInternalUsers></allInternalUsers>"),
        criteria("Finance_Read", "Read", "<group>Finance</group>"),
        guest("Public_Invoices"),
      ),
    );
    const fs = changed(
      "sharingRules/Invoice__c.sharingRules-meta.xml",
      rules(
        criteria("Finance_Read", "Read", "<group>Finance</group>", "Status"),
        criteria("Old_Rule", "Edit", "<role>CEO</role>"),
      ),
    );
    expect(
      fs
        .filter((f) => f.rule === "sharing-rule-changed" || f.rule === "guest-access")
        .map((f) => [f.rule, f.severity, f.title]),
    ).toEqual([
      [
        "sharing-rule-changed",
        "high",
        "Sharing rule Invoice__c.All_Edit gives all internal users Edit access to Invoice__c records",
      ],
      [
        "guest-access",
        "high",
        "Guest sharing rule Invoice__c.Public_Invoices gives guest (unauthenticated) users Read access to Invoice__c records",
      ],
      ["sharing-rule-changed", "medium", "1 sharing rule on Invoice__c removed or reduced"],
      ["sharing-rule-changed", "low", "Sharing rule Invoice__c.Finance_Read now shares a different set of records"],
    ]);
  });

  it("follows permission set groups: added sets that escalate, removed sets and mutes", () => {
    write(
      "permissionsets/Ops_Admin.permissionset-meta.xml",
      permset({ objects: [["Invoice__c", "rceM"]], system: ["ModifyAllData"] }),
    );
    const group = (sets: string[], mutes: string[] = []) =>
      `<PermissionSetGroup ${NS}>${sets.map((s) => `<permissionSets>${s}</permissionSets>`).join("")}${mutes
        .map((m) => `<mutingPermissionSets>${m}</mutingPermissionSets>`)
        .join("")}<label>G</label></PermissionSetGroup>`;
    write("permissionsetgroups/Sales_Team.permissionsetgroup-meta.xml", group(["Ops_Admin"], ["Mute_Delete"]));
    const fs = changed("permissionsetgroups/Sales_Team.permissionsetgroup-meta.xml", group(["Billing"]));
    expect(fs.map((f) => [f.rule, f.severity])).toEqual(
      expect.arrayContaining([
        ["permission-escalation", "high"],
        ["permission-access-removed", "medium"],
      ]),
    );
    expect(byRule(fs, "permission-escalation")[0]?.title).toContain("Modify All on Invoice__c (from Ops_Admin)");
    expect(byRule(fs, "permission-escalation")[0]?.title).toContain("ModifyAllData (from Ops_Admin)");
    // A permission set that escalates says which groups carry it to users.
    const ps = changed(
      "permissionsets/Ops_Admin.permissionset-meta.xml",
      permset({ objects: [["Invoice__c", "rce"]] }),
    );
    expect(byRule(ps, "permission-escalation")[0]?.detail).toContain("permission set group(s) Sales_Team");
  });

  it("reports what a muting permission set newly mutes", () => {
    write(
      "permissionsetgroups/Sales_Team.permissionsetgroup-meta.xml",
      `<PermissionSetGroup ${NS}><mutingPermissionSets>Mute_Delete</mutingPermissionSets></PermissionSetGroup>`,
    );
    write(
      "mutingpermissionsets/Mute_Delete.mutingpermissionset-meta.xml",
      permset({ root: "MutingPermissionSet", objects: [["Invoice__c", "d"]] }),
    );
    const [f] = byRule(
      changed(
        "mutingpermissionsets/Mute_Delete.mutingpermissionset-meta.xml",
        permset({ root: "MutingPermissionSet" }),
      ),
      "permission-access-removed",
    );
    expect(f?.title).toBe("Muting permission set Mute_Delete now mutes 1 permission");
    expect(f?.detail).toContain("Invoice__c (delete)");
    expect(f?.detail).toContain("Sales_Team");
  });
});
