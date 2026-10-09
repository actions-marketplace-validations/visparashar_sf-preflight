// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, loadProject } from "../src/core/index.js";
import { classifyPath } from "../src/core/project.js";
import { distinctive, referencePatterns } from "../src/core/references.js";
import type { Change, Finding } from "../src/core/types.js";

const base = "force-app/main/default/";

describe("reference patterns", () => {
  it("treats ordinary words as too common to match on their own", () => {
    expect(distinctive("Sales")).toBe(false);
    expect(distinctive("Default")).toBe(false);
    expect(distinctive("Can_Approve")).toBe(true);
    expect(distinctive("jqueryUi")).toBe(true);
  });

  it("ignores elements that declare a name or hold text", () => {
    const res = referencePatterns(classifyPath(`${base}customPermissions/Can_Approve.customPermission-meta.xml`));
    expect(res.some((r) => r.test("<fullName>Can_Approve</fullName>"))).toBe(false);
    expect(res.some((r) => r.test("<label>Can_Approve</label>"))).toBe(false);
    expect(res.some((r) => r.test("<name>Can_Approve</name>"))).toBe(true);
    const vf = referencePatterns(classifyPath(`${base}components/Header_Bar.component`));
    expect(vf.some((r) => r.test("<c:Header_Bar title='x'/>"))).toBe(true);
    expect(vf.some((r) => r.test("<name>Header_Bar</name>"))).toBe(false);
  });

  it("uses the type's own syntax for common names", () => {
    const res = referencePatterns(classifyPath(`${base}namedCredentials/Stripe.namedCredential-meta.xml`));
    expect(res.some((r) => r.test("req.setEndpoint('callout:Stripe/v1/charges');"))).toBe(true);
    expect(res.some((r) => r.test("<label>Stripe</label>"))).toBe(false);
  });
});

describe("the reference check in the analysis", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const deleted = (rel: string): Change => ({ changeType: "deleted", component: classifyPath(base + rel) });
  const run = (...changes: Change[]): Finding[] =>
    analyze({ model: loadProject(dir, { cache: false }), changes }).findings;
  const byRule = (fs: Finding[], rule: string) => fs.filter((f) => f.rule === rule);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-refs-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("pages/Home.page", '<apex:page><apex:includeScript value="{!$Resource.jquery_ui}"/></apex:page>');
    write("lwc/chart/chart.js", "import LIB from '@salesforce/resourceUrl/jquery_ui'; export default class Chart {}");
    write(
      "classes/Payments.cls",
      "public class Payments { public void go(){ HttpRequest r = new HttpRequest(); r.setEndpoint('callout:Stripe/v1'); if (FeatureManagement.checkPermission('Can_Approve')) {} List<Invoice__c> xs = [SELECT Id FROM Invoice__c]; } }",
    );
    write(
      "objects/Account/fields/Region__c.field-meta.xml",
      "<CustomField><fullName>Region__c</fullName><valueSet><valueSetName>Regions</valueSetName></valueSet></CustomField>",
    );
    write("objects/Account/fields/Note__c.field-meta.xml", "<CustomField><label>Regions</label></CustomField>");
    write(
      "profiles/Admin.profile-meta.xml",
      "<Profile><applicationVisibilities><application>Sales</application></applicationVisibilities><custom>Sales</custom></Profile>",
    );
    write("applications/Other.app-meta.xml", "<CustomApplication><label>Sales</label></CustomApplication>");
    write("staticresources/charts/b.js", "x");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a deleted static resource named in a page and a Lightning component", () => {
    const [f] = byRule(run(deleted("staticresources/jquery_ui.resource-meta.xml")), "deleted-still-named");
    expect(f?.severity).toBe("medium");
    expect(f?.detail).toContain("Home.page");
    expect(f?.detail).toContain("chart.js");
  });

  it("finds a named credential, a custom permission and a custom object by their own syntax", () => {
    const fs = byRule(
      run(
        deleted("namedCredentials/Stripe.namedCredential-meta.xml"),
        deleted("customPermissions/Can_Approve.customPermission-meta.xml"),
        deleted("objects/Invoice__c/Invoice__c.object-meta.xml"),
      ),
      "deleted-still-named",
    );
    expect(fs.map((f) => f.title)).toEqual([
      expect.stringContaining("NamedCredential Stripe"),
      expect.stringContaining("CustomPermission Can_Approve"),
      expect.stringContaining("Invoice__c"),
    ]);
    for (const f of fs) expect(f.files).toContain(`${base}classes/Payments.cls`);
  });

  it("matches a common name only where that type is referenced", () => {
    const [vs] = byRule(run(deleted("globalValueSets/Regions.globalValueSet-meta.xml")), "deleted-still-named");
    expect(vs?.files).toContain(`${base}objects/Account/fields/Region__c.field-meta.xml`);
    expect(vs?.files).not.toContain(`${base}objects/Account/fields/Note__c.field-meta.xml`);
    const [app] = byRule(run(deleted("applications/Sales.app-meta.xml")), "deleted-still-named");
    expect(app?.files).toEqual([`${base}applications/Sales.app-meta.xml`, `${base}profiles/Admin.profile-meta.xml`]);
  });

  it("stays quiet when a bundle keeps other files, or nothing names the component", () => {
    const fs = run(deleted("staticresources/charts/a.js"), deleted("staticresources/unused_lib.resource-meta.xml"));
    expect(byRule(fs, "deleted-still-named")).toEqual([]);
    expect(byRule(fs, "metadata-not-analyzed").length).toBe(2);
  });

  it("leaves types with precise checks to them", () => {
    const fs = run(deleted("classes/Gone.cls"), deleted("flows/Gone.flow-meta.xml"));
    expect(byRule(fs, "deleted-still-named")).toEqual([]);
  });

  it("flags a rename whose old name is still used, and not one whose references moved with it", () => {
    write("staticresources/charts_v2.resource-meta.xml", "<StaticResource/>");
    const renamed = (from: string, to: string): Change => ({
      changeType: "renamed",
      component: classifyPath(base + to),
      previousFile: base + from,
    });
    const [f] = byRule(
      run(renamed("staticresources/jquery_ui.resource-meta.xml", "staticresources/charts_v2.resource-meta.xml")),
      "renamed-still-named",
    );
    expect(f?.title).toContain("jquery_ui was renamed to charts_v2");
    expect(f?.detail).toContain("Home.page");
    expect(
      byRule(
        run(renamed("staticresources/old_unused.resource-meta.xml", "staticresources/charts_v2.resource-meta.xml")),
        "renamed-still-named",
      ),
    ).toEqual([]);
  });

  it("checks renamed fields, whose old name code uses unquoted", () => {
    write("objects/Opportunity/fields/New_Amount__c.field-meta.xml", "<CustomField/>");
    write("classes/Calc.cls", "public class Calc { Decimal f(Opportunity o){ return o.Old_Amount__c; } }");
    const [f] = byRule(
      run({
        changeType: "renamed",
        component: classifyPath(`${base}objects/Opportunity/fields/New_Amount__c.field-meta.xml`),
        previousFile: `${base}objects/Opportunity/fields/Old_Amount__c.field-meta.xml`,
      }),
      "renamed-still-named",
    );
    expect(f?.files).toContain(`${base}classes/Calc.cls`);
  });
});
