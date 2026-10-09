// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, analyzeChange, loadProject } from "../src/core/index.js";
import { parseLightningBundle } from "../src/core/parsers/lightning.js";
import { classifyPath } from "../src/core/project.js";
import type { Change } from "../src/core/types.js";

describe("Lightning bundle parser", () => {
  const isObject = (n: string) => /^(Opportunity|Account)$|__c$/.test(n);

  it("reads Apex imports, schema fields, labels and child components from an LWC", () => {
    const def = parseLightningBundle(
      "lwc",
      "dealCard",
      "lwc/dealCard/dealCard.js-meta.xml",
      [
        {
          path: "lwc/dealCard/dealCard.js",
          text: `import getDeal from '@salesforce/apex/DealController.getDeal';
import CONTRACT from '@salesforce/schema/Opportunity.Contract_Signed_Date__c';
import OPP from '@salesforce/schema/Opportunity';
import hello from '@salesforce/label/c.Hello';
import { helper } from 'c/helperUtils';
const fields = ['Account.Industry', 'lightning.button'];`,
        },
        {
          path: "lwc/dealCard/dealCard.html",
          text: "<template><c-price-badge></c-price-badge><lightning-card/></template>",
        },
      ],
      isObject,
    );
    expect(def.apex).toEqual([{ cls: "DealController", method: "getDeal" }]);
    expect(def.fields.sort()).toEqual(["Account.Industry", "Opportunity.Contract_Signed_Date__c"]);
    expect(def.objects).toEqual(["Opportunity"]);
    expect(def.labels).toEqual(["Hello"]);
    expect(def.children.sort()).toEqual(["helperUtils", "priceBadge"]);
  });

  it("reads an Aura bundle's controller, methods and children", () => {
    const def = parseLightningBundle(
      "aura",
      "legacyCard",
      "aura/legacyCard/legacyCard.cmp",
      [
        {
          path: "aura/legacyCard/legacyCard.cmp",
          text: `<aura:component controller="ns.DealController"><c:priceBadge/>{!$Label.c.Hello}</aura:component>`,
        },
        { path: "aura/legacyCard/legacyCardController.js", text: `var a = component.get("c.save");` },
      ],
      isObject,
    );
    expect(def.apex).toEqual([{ cls: "DealController" }, { cls: "DealController", method: "save" }]);
    expect(def.children).toEqual(["priceBadge"]);
    expect(def.labels).toEqual(["Hello"]);
  });
});

describe("Lightning in the analysis", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, "force-app/main/default", rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const abs = (...rel: string[]) => rel.map((r) => path.join(dir, "force-app/main/default", r));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-lwc-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("objects/Opportunity/Opportunity.object-meta.xml", "<CustomObject/>");
    write(
      "objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml",
      `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Contract_Signed_Date__c</fullName><label>Signed</label><type>Date</type></CustomField>`,
    );
    write(
      "classes/DealController.cls",
      "public with sharing class DealController { @AuraEnabled public static void save(Id oppId) { Opportunity o = [SELECT Id FROM Opportunity WHERE Id = :oppId]; update o; } }",
    );
    write(
      "lwc/dealCard/dealCard.js",
      `import save from '@salesforce/apex/DealController.save';
import SIGNED from '@salesforce/schema/Opportunity.Contract_Signed_Date__c';
import GONE from '@salesforce/schema/Opportunity.Removed_Field__c';
import missing from '@salesforce/apex/NoSuchClass.run';`,
    );
    write("lwc/dealCard/dealCard.html", "<template><c-price-badge></c-price-badge></template>");
    write("lwc/priceBadge/priceBadge.js", "export default class PriceBadge {}");
    write(
      "aura/legacyCard/legacyCard.cmp",
      `<aura:component controller="DealController"><c:priceBadge/></aura:component>`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads bundles into the model", () => {
    const model = loadProject(dir, { cache: false });
    expect([...model.lightning.keys()].sort()).toEqual(["aura:legacycard", "lwc:dealcard", "lwc:pricebadge"]);
  });

  it("lists Lightning components that use a changed field", () => {
    const { result } = analyzeChange({
      projectDir: dir,
      files: abs("objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml"),
    });
    expect(result.references.filter((r) => r.from.kind === "LightningComponent").map((r) => r.from.name)).toEqual([
      "dealCard",
    ]);
    const f = result.findings.find((x) => x.rule === "field-used-by-lightning");
    expect(f?.severity).toBe("low");
    expect(f?.detail).toContain("dealCard");
  });

  it("warns when a changed Apex class is called from Lightning components", () => {
    const { result } = analyzeChange({ projectDir: dir, files: abs("classes/DealController.cls") });
    const f = result.findings.find((x) => x.rule === "apex-called-from-lightning");
    expect(f?.title).toContain("2 Lightning component(s)");
    expect(f?.detail).toContain("dealCard");
    expect(f?.detail).toContain("legacyCard");
  });

  it("follows what a changed component saves, flags what it uses that is missing, and counts as analyzed in depth", () => {
    const { result } = analyzeChange({ projectDir: dir, files: abs("lwc/dealCard/dealCard.js") });
    expect(result.impactedObjects).toContain("Opportunity");
    const missing = result.findings.find((x) => x.rule === "lightning-missing-reference");
    expect(missing?.severity).toBe("medium");
    expect(missing?.detail).toContain("Opportunity.Removed_Field__c");
    expect(missing?.detail).toContain("NoSuchClass");
    expect(missing?.detail).not.toContain("Contract_Signed_Date__c");
    expect(result.findings.some((x) => x.rule === "metadata-not-analyzed")).toBe(false);
    expect(result.coverage).toBeUndefined();
  });

  it("blocks deleting a component that others embed", () => {
    rmSync(path.join(dir, "force-app/main/default/lwc/priceBadge"), { recursive: true });
    const model = loadProject(dir, { cache: false });
    const change: Change = {
      changeType: "deleted",
      component: classifyPath("force-app/main/default/lwc/priceBadge/priceBadge.js"),
    };
    const result = analyze({ model, changes: [change] });
    const f = result.findings.find((x) => x.rule === "deleted-still-referenced");
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("dealCard");
    expect(f?.detail).toContain("legacyCard");
  });

  it("includes Lightning callers when a class is deleted", () => {
    rmSync(path.join(dir, "force-app/main/default/classes"), { recursive: true });
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      changes: [
        { changeType: "deleted", component: classifyPath("force-app/main/default/classes/DealController.cls") },
      ],
    });
    expect(result.findings.find((x) => x.rule === "deleted-still-referenced")?.detail).toContain("dealCard");
  });
});
