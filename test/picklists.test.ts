// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, loadProject } from "../src/core/index.js";
import { parseField } from "../src/core/parsers/fields.js";
import { parseRecordType } from "../src/core/parsers/recordTypes.js";
import { classifyPath } from "../src/core/project.js";

const FIELD = (...values: ([string] | [string, false])[]) =>
  `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Stage__c</fullName><label>Stage</label><type>Picklist</type><valueSet><valueSetDefinition><sorted>false</sorted>${values
    .map(
      ([v, a]) =>
        `<value><fullName>${v}</fullName><default>false</default><label>${v}</label>${a === false ? "<isActive>false</isActive>" : ""}</value>`,
    )
    .join("")}</valueSetDefinition></valueSet></CustomField>`;

const RT = (active: boolean, ...values: string[]) =>
  `<RecordType xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Renewal</fullName><active>${active}</active><label>Renewal</label><picklistValues><picklist>Stage__c</picklist>${values
    .map((v) => `<values><fullName>${v}</fullName><default>false</default></values>`)
    .join("")}</picklistValues></RecordType>`;

describe("picklist parsers", () => {
  it("reads values, activity and URL-encoded names", () => {
    const f = parseField(FIELD(["Open"], ["Won%2FLost", false]), "Opportunity", "Stage__c", "f");
    expect(f.picklist?.values).toEqual([
      { name: "Open", active: true },
      { name: "Won/Lost", active: false },
    ]);
    const rt = parseRecordType(RT(true, "Open", "Won%2FLost"), "Opportunity", "Renewal", "f");
    expect(rt.picklists.Stage__c).toEqual(["Open", "Won/Lost"]);
    expect(rt.active).toBe(true);
  });
});

describe("picklists and record types in the analysis", () => {
  let dir: string;
  const base = "force-app/main/default/";
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const FIELD_FILE = "objects/Opportunity/fields/Stage__c.field-meta.xml";
  const RT_FILE = "objects/Opportunity/recordTypes/Renewal.recordType-meta.xml";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-pick-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("objects/Opportunity/Opportunity.object-meta.xml", "<CustomObject/>");
    write(FIELD_FILE, FIELD(["Open"]));
    write(RT_FILE, RT(true, "Open", "Legacy"));
    write(
      "classes/Closer.cls",
      "public class Closer { public static void run(Opportunity o){ if (o.Stage__c == 'Legacy') { o.Name = 'x'; } } }",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags removed values that record types and code still use", () => {
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      readBase: () => FIELD(["Open"], ["Legacy"]),
      changes: [{ changeType: "modified", component: classifyPath(base + FIELD_FILE) }],
    });
    const f = result.findings.find((x) => x.rule === "picklist-value-removed");
    expect(f?.severity).toBe("medium");
    expect(f?.title).toContain("Legacy");
    expect(f?.detail).toContain("Renewal");
    expect(f?.detail).toContain("Closer.cls");
  });

  it("is low when nothing uses the removed value, and silent when none was removed", () => {
    write(RT_FILE, RT(true, "Open"));
    write("classes/Closer.cls", "public class Closer {}");
    const model = loadProject(dir, { cache: false });
    const change = [{ changeType: "modified" as const, component: classifyPath(base + FIELD_FILE) }];
    const low = analyze({ model, readBase: () => FIELD(["Open"], ["Legacy"]), changes: change });
    expect(low.findings.find((x) => x.rule === "picklist-value-removed")?.severity).toBe("low");
    const none = analyze({ model, readBase: () => FIELD(["Open"]), changes: change });
    expect(none.findings.some((x) => x.rule === "picklist-value-removed")).toBe(false);
  });

  it("treats a deactivated value as removed", () => {
    write(FIELD_FILE, FIELD(["Open"], ["Legacy", false]));
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      readBase: () => FIELD(["Open"], ["Legacy"]),
      changes: [{ changeType: "modified", component: classifyPath(base + FIELD_FILE) }],
    });
    expect(result.findings.some((x) => x.rule === "picklist-value-removed")).toBe(true);
  });

  it("reports what a record type stopped offering, and deactivation", () => {
    write(RT_FILE, RT(false, "Open"));
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      readBase: () => RT(true, "Open", "Legacy"),
      changes: [{ changeType: "modified", component: classifyPath(base + RT_FILE) }],
    });
    expect(result.findings.find((x) => x.rule === "record-type-values-removed")?.detail).toContain("Stage__c: Legacy");
    expect(result.findings.some((x) => x.rule === "record-type-deactivated")).toBe(true);
  });

  it("flags a deleted record type that code still names", () => {
    write(
      "classes/Closer.cls",
      "public class Closer { Boolean r(Opportunity o){ return o.RecordType.DeveloperName == 'Renewal'; } }",
    );
    rmSync(path.join(dir, base, RT_FILE));
    const model = loadProject(dir, { cache: false });
    const result = analyze({
      model,
      changes: [{ changeType: "deleted", component: classifyPath(base + RT_FILE) }],
    });
    const f = result.findings.find((x) => x.rule === "record-type-still-referenced");
    expect(f?.severity).toBe("medium");
    expect(f?.detail).toContain("Closer.cls");
  });
});
