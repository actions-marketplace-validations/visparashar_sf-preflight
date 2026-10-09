// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, analyzeChange, loadProject } from "../src/core/index.js";
import { customComponent, parseFlexiPage, parseLayout } from "../src/core/parsers/pages.js";
import { classifyPath } from "../src/core/project.js";
import type { Change } from "../src/core/types.js";

const LAYOUT = (...fields: string[]) =>
  `<Layout xmlns="http://soap.sforce.com/2006/04/metadata"><layoutSections><layoutColumns>${fields
    .map((f) => `<layoutItems><behavior>Edit</behavior><field>${f}</field></layoutItems>`)
    .join("")}</layoutColumns></layoutSections></Layout>`;

const PAGE = (components: string[], fields: string[] = []) =>
  `<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata"><flexiPageRegions>${components
    .map(
      (c) =>
        `<itemInstances><componentInstance><componentName>${c}</componentName></componentInstance></itemInstances>`,
    )
    .join("")}${fields
    .map(
      (f) =>
        `<itemInstances><componentInstance><componentName>force:detailPanel</componentName><visibilityRule><criteria><leftValue>{!Record.${f}}</leftValue></criteria></visibilityRule></componentInstance></itemInstances>`,
    )
    .join("")}</flexiPageRegions><sobjectType>Opportunity</sobjectType><type>RecordPage</type></FlexiPage>`;

describe("page parsers", () => {
  it("reads a layout's fields and its object from the name", () => {
    const l = parseLayout(LAYOUT("Name", "Contract_Signed_Date__c", "Name"), "Opportunity-Deal Layout", "f");
    expect(l.object).toBe("Opportunity");
    expect(l.fields).toEqual(["Name", "Contract_Signed_Date__c"]);
  });

  it("reads a Lightning page's components and record fields", () => {
    const p = parseFlexiPage(
      PAGE(["c:dealCard", "force:highlightsPanel", "legacyBadge"], ["Contract_Signed_Date__c"]),
      "Deal_Page",
      "f",
    );
    expect(p.object).toBe("Opportunity");
    expect(p.components).toEqual(["c:dealCard", "force:highlightsPanel", "legacyBadge", "force:detailPanel"]);
    expect(p.fields).toEqual(["Opportunity.Contract_Signed_Date__c"]);
  });

  it("tells custom components from standard ones", () => {
    expect(customComponent("c:dealCard")).toBe("dealCard");
    expect(customComponent("legacyBadge")).toBe("legacyBadge");
    expect(customComponent("force:detailPanel")).toBeUndefined();
    expect(customComponent("lightning:card")).toBeUndefined();
    expect(customComponent("ns:managed")).toBeUndefined();
  });
});

describe("pages in the analysis", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, "force-app/main/default", rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const abs = (...rel: string[]) => rel.map((r) => path.join(dir, "force-app/main/default", r));
  const FIELD = "objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-pages-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("objects/Opportunity/Opportunity.object-meta.xml", "<CustomObject/>");
    write(
      FIELD,
      `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Contract_Signed_Date__c</fullName><label>Signed</label><type>Date</type></CustomField>`,
    );
    write("layouts/Opportunity-Deal Layout.layout-meta.xml", LAYOUT("Name", "Contract_Signed_Date__c"));
    write(
      "flexipages/Deal_Page.flexipage-meta.xml",
      PAGE(["c:dealCard", "force:highlightsPanel"], ["Contract_Signed_Date__c"]),
    );
    write("lwc/dealCard/dealCard.js", "export default class DealCard {}");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads layouts and Lightning pages into the model", () => {
    const m = loadProject(dir, { cache: false });
    expect([...m.layouts.keys()]).toEqual(["opportunity-deal layout"]);
    expect([...m.flexipages.keys()]).toEqual(["deal_page"]);
  });

  it("says where a changed field is shown", () => {
    const { result } = analyzeChange({ projectDir: dir, files: abs(FIELD) });
    const kinds = result.references.map((r) => r.from.kind).sort();
    expect(kinds).toEqual(["FlexiPage", "Layout"]);
    expect(result.findings.find((f) => f.rule === "field-on-page")?.severity).toBe("info");
  });

  it("flags deleting a field that a layout still shows", () => {
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      changes: [{ changeType: "deleted", component: classifyPath(`force-app/main/default/${FIELD}`) }],
    });
    const f = result.findings.find((x) => x.rule === "deleted-still-referenced");
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("Layout");
  });

  it("says which pages a changed component is placed on, and blocks deleting one still placed", () => {
    const { result } = analyzeChange({ projectDir: dir, files: abs("lwc/dealCard/dealCard.js") });
    expect(result.findings.find((f) => f.rule === "lightning-on-page")?.detail).toContain("Deal_Page");

    rmSync(path.join(dir, "force-app/main/default/lwc/dealCard"), { recursive: true });
    const model = loadProject(dir, { cache: false });
    const deleted: Change = {
      changeType: "deleted",
      component: classifyPath("force-app/main/default/lwc/dealCard/dealCard.js"),
    };
    const gone = analyze({ model, changes: [deleted] }).findings.find((f) => f.rule === "deleted-still-referenced");
    expect(gone?.severity).toBe("high");
    expect(gone?.detail).toContain("page Deal_Page");
  });

  it("flags what a changed page names that the project lacks, and what it dropped", () => {
    write("layouts/Opportunity-Deal Layout.layout-meta.xml", LAYOUT("Name", "Nope__c"));
    write("flexipages/Deal_Page.flexipage-meta.xml", PAGE(["c:ghostCard", "force:highlightsPanel"]));
    const model = loadProject(dir, { cache: false });
    const readBase = (file: string) =>
      file.endsWith(".layout-meta.xml")
        ? LAYOUT("Name", "Contract_Signed_Date__c")
        : PAGE(["c:dealCard", "force:highlightsPanel"]);
    const result = analyze({
      model,
      readBase,
      changes: [
        {
          changeType: "modified",
          component: classifyPath("force-app/main/default/layouts/Opportunity-Deal Layout.layout-meta.xml"),
        },
        {
          changeType: "modified",
          component: classifyPath("force-app/main/default/flexipages/Deal_Page.flexipage-meta.xml"),
        },
      ],
    });
    const missing = result.findings.filter((f) => f.rule === "page-missing-reference");
    expect(missing).toHaveLength(2);
    expect(missing.map((f) => f.detail).join(" ")).toContain("Opportunity.Nope__c");
    expect(missing.map((f) => f.detail).join(" ")).toContain("c:ghostCard");
    const removed = result.findings.filter((f) => f.rule === "page-element-removed");
    expect(removed).toHaveLength(2);
    expect(removed.map((f) => f.detail).join(" ")).toContain("Opportunity.Contract_Signed_Date__c");
    expect(removed.map((f) => f.detail).join(" ")).toContain("c:dealCard");
    expect(result.coverage).toBeUndefined(); // both counted as analyzed in depth
  });
});
