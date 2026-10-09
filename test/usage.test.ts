// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, analyzeChange, loadProject } from "../src/core/index.js";
import { classifyPath } from "../src/core/project.js";
import { parseVisualforce } from "../src/core/usage.js";

const LABELS = (...names: string[]) =>
  `<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">${names
    .map(
      (n) =>
        `<labels><fullName>${n}</fullName><value>v</value><language>en_US</language><protected>false</protected><shortDescription>${n}</shortDescription></labels>`,
    )
    .join("")}</CustomLabels>`;

describe("Visualforce parsing", () => {
  it("reads controller and extensions, ignoring standardController", () => {
    expect(
      parseVisualforce('<apex:page standardController="Account" extensions="A, B" controller="C"></apex:page>'),
    ).toEqual(["C", "A", "B"]);
    expect(parseVisualforce('<apex:page standardController="Account"/>')).toEqual([]);
  });
});

describe("labels, custom metadata and Visualforce in the analysis", () => {
  let dir: string;
  const base = "force-app/main/default/";
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const LABEL_FILE = "labels/CustomLabels.labels-meta.xml";
  const abs = (...rel: string[]) => rel.map((r) => path.join(dir, base, r));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-usage-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(LABEL_FILE, LABELS("Welcome"));
    write("classes/Greeter.cls", "public class Greeter { public String hi(){ return System.Label.Old_Greeting; } }");
    write("pages/Home.page", '<apex:page controller="Greeter">{!$Label.Old_Greeting}</apex:page>');
    write("pages/Ghost.page", '<apex:page controller="NoSuchController"/>');
    write("lwc/banner/banner.js", "import OLD from '@salesforce/label/c.Old_Greeting'; export default class Banner {}");
    write(
      "customMetadata/Fee_Rule.Standard.md-meta.xml",
      '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"><label>Standard</label></CustomMetadata>',
    );
    write(
      "classes/Fees.cls",
      "public class Fees { public static Decimal f(){ return Fee_Rule__mdt.getInstance('Standard').Rate__c; } }",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags a removed label that Apex, pages and Lightning still use", () => {
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      readBase: () => LABELS("Welcome", "Old_Greeting"),
      changes: [{ changeType: "modified", component: classifyPath(base + LABEL_FILE) }],
    });
    const f = result.findings.find((x) => x.rule === "label-removed-still-used");
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("Greeter.cls");
    expect(f?.detail).toContain("Home.page");
    expect(f?.detail).toContain("banner.js");
  });

  it("is silent when the label still exists or nothing uses the removed one", () => {
    const model = loadProject(dir, { cache: false });
    const change = [{ changeType: "modified" as const, component: classifyPath(base + LABEL_FILE) }];
    expect(analyze({ model, readBase: () => LABELS("Welcome"), changes: change }).findings).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ rule: "label-removed-still-used" })]),
    );
    expect(
      analyze({ model, readBase: () => LABELS("Welcome", "Unused_One"), changes: change }).findings.some(
        (x) => x.rule === "label-removed-still-used",
      ),
    ).toBe(false);
  });

  it("lists who reads a changed custom metadata record, and who names a deleted one", () => {
    const changed = analyzeChange({ projectDir: dir, files: abs("customMetadata/Fee_Rule.Standard.md-meta.xml") });
    const info = changed.result.findings.find((x) => x.rule === "cmdt-record-changed");
    expect(info?.severity).toBe("info");
    expect(info?.detail).toContain("Fees.cls");

    const model = loadProject(dir, { cache: false });
    const gone = analyze({
      model,
      changes: [
        { changeType: "deleted", component: classifyPath(`${base}customMetadata/Fee_Rule.Standard.md-meta.xml`) },
      ],
    });
    expect(gone.findings.find((x) => x.rule === "cmdt-record-still-referenced")?.severity).toBe("medium");
  });

  it("says which pages use a changed class, and fails a deleted one", () => {
    const changed = analyzeChange({ projectDir: dir, files: abs("classes/Greeter.cls") });
    const f = changed.result.findings.find((x) => x.rule === "apex-used-by-page");
    expect(f?.severity).toBe("info");
    expect(f?.detail).toContain("Home");

    rmSync(path.join(dir, base, "classes/Greeter.cls"));
    const model = loadProject(dir, { cache: false });
    const gone = analyze({
      model,
      changes: [{ changeType: "deleted", component: classifyPath(`${base}classes/Greeter.cls`) }],
    });
    expect(gone.findings.find((x) => x.rule === "apex-used-by-page")?.severity).toBe("high");
  });

  it("flags a changed page that names a missing controller", () => {
    const { result } = analyzeChange({ projectDir: dir, files: abs("pages/Ghost.page", "pages/Home.page") });
    const f = result.findings.filter((x) => x.rule === "visualforce-missing-reference");
    expect(f).toHaveLength(1);
    expect(f[0]?.title).toContain("NoSuchController");
  });

  it("counts these types as analyzed in depth", () => {
    const { result } = analyzeChange({ projectDir: dir, files: abs("pages/Home.page", LABEL_FILE) });
    expect(result.coverage).toBeUndefined();
  });
});
