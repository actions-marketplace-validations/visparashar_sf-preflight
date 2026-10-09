// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, toMarkdown } from "../src/core/index.js";
import { classifyPath } from "../src/core/project.js";

const at = (f: string) => classifyPath(`force-app/main/default/${f}`);

describe("metadata type recognition", () => {
  it.each([
    ["layouts/Account-Account Layout.layout-meta.xml", "Layout", "Account-Account Layout"],
    ["flexipages/Home.flexipage-meta.xml", "FlexiPage", "Home"],
    ["lwc/myCmp/myCmp.js", "LightningComponentBundle", "myCmp"],
    ["lwc/myCmp/__tests__/myCmp.test.js", "LightningComponentBundle", "myCmp"],
    ["lwc/myCmp/myCmp.js-meta.xml", "LightningComponentBundle", "myCmp"],
    ["aura/Foo/FooController.js", "AuraDefinitionBundle", "Foo"],
    ["reports/MyFolder/Sub/Pipeline.report-meta.xml", "Report", "MyFolder/Sub/Pipeline"],
    ["email/Folder/Welcome.email-meta.xml", "EmailTemplate", "Folder/Welcome"],
    ["staticresources/logo.resource-meta.xml", "StaticResource", "logo"],
    ["staticresources/app/main.js", "StaticResource", "app"],
    ["pages/Foo.page", "ApexPage", "Foo"],
    ["customMetadata/Rule.Default.md-meta.xml", "CustomMetadata", "Rule.Default"],
    ["labels/CustomLabels.labels-meta.xml", "CustomLabels", "CustomLabels"],
    ["permissionsetgroups/G.permissionsetgroup-meta.xml", "PermissionSetGroup", "G"],
  ])("%s is %s", (file, type, name) => {
    const c = at(file);
    expect(c.type).toBe("Metadata");
    expect(c.metadataType).toBe(type);
    expect(c.name).toBe(name);
  });

  it("keeps the types that have their own analysis", () => {
    expect(at("classes/Foo.cls").type).toBe("ApexClass");
    expect(at("flows/F.flow-meta.xml").type).toBe("Flow");
    expect(at("objects/Account/fields/X__c.field-meta.xml").type).toBe("CustomField");
    expect(at("workflows/Account.workflow-meta.xml").type).toBe("WorkflowRule");
  });

  it("does not mistake other files for metadata", () => {
    for (const f of ["README.md", "package.json", ".forceignore", "lwc/jsconfig.json", "documents/F/x.png"]) {
      expect(classifyPath(f).type).toBe("Other");
    }
    expect(classifyPath("docs/guide.page").type).toBe("Other"); // .page outside pages/
  });
});

describe("coverage", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, "force-app/main/default", rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-cov-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("classes/Util.cls", "public class Util { public static void run() {} }");
    write("lwc/priceBadge/priceBadge.js", "export default class PriceBadge {}");
    write("lwc/priceBadge/priceBadge.html", "<template></template>");
    write("lwc/dealCard/dealCard.html", "<template><c-price-badge></c-price-badge></template>");
    write("lwc/dealCard/dealCard.js", "import x from 'c/priceBadge';");
    write("layouts/Opportunity-Deal Layout.layout-meta.xml", "<Layout/>");
    write(
      "profiles/Admin.profile-meta.xml",
      "<Profile><layoutAssignments><layout>Opportunity-Deal Layout</layout></layoutAssignments></Profile>",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const files = (...rel: string[]) => rel.map((r) => path.join(dir, "force-app/main/default", r));

  it("counts deep and basic changes and finds who mentions the basic ones", () => {
    const { result } = analyzeChange({
      projectDir: dir,
      files: files(
        "classes/Util.cls",
        "lwc/priceBadge/priceBadge.js",
        "layouts/Opportunity-Deal Layout.layout-meta.xml",
      ),
    });
    expect(result.coverage?.deep).toBe(1);
    expect(result.coverage?.basic).toBe(2);
    expect(result.coverage?.basicByType).toEqual([
      { type: "Layout", count: 1 },
      { type: "LightningComponentBundle", count: 1 },
    ]);
    const bySlot = Object.fromEntries(result.coverage?.mentions.map((m) => [m.component, m.files]) ?? []);
    // The bundle's own files do not count; the other component's template and import do.
    expect(bySlot.priceBadge).toEqual([
      "force-app/main/default/lwc/dealCard/dealCard.html",
      "force-app/main/default/lwc/dealCard/dealCard.js",
    ]);
    expect(bySlot["Opportunity-Deal Layout"]).toEqual(["force-app/main/default/profiles/Admin.profile-meta.xml"]);
    expect(result.findings.filter((f) => f.rule === "metadata-not-analyzed")).toHaveLength(2);
    expect(result.findings.find((f) => f.title.includes("priceBadge"))?.severity).toBe("info");
  });

  it("says so in the report, and says nothing when everything is analyzed in depth", () => {
    const md = toMarkdown(
      analyzeChange({
        projectDir: dir,
        files: files("classes/Util.cls", "layouts/Opportunity-Deal Layout.layout-meta.xml"),
      }).result,
    );
    expect(md).toContain("Analyzed in depth: **1** of **2**");
    expect(md).toContain("Layout ×1");
    expect(md).toContain("### Not analyzed in depth");
    const only = analyzeChange({ projectDir: dir, files: files("classes/Util.cls") }).result;
    expect(only.coverage).toBeUndefined();
    expect(toMarkdown(only)).not.toContain("Analyzed in depth");
  });

  it("can be switched off like any rule", () => {
    writeFileSync(path.join(dir, ".preflight.json"), JSON.stringify({ rules: { "metadata-not-analyzed": "off" } }));
    const { result } = analyzeChange({
      projectDir: dir,
      files: files("layouts/Opportunity-Deal Layout.layout-meta.xml"),
    });
    expect(result.findings.filter((f) => f.rule === "metadata-not-analyzed")).toHaveLength(0);
    expect(result.coverage?.basic).toBe(1); // the summary still says it
  });
});
