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
    write("tabs/DealHome.tab-meta.xml", "<CustomTab/>");
    write("quickActions/Opportunity.NewDeal.quickAction-meta.xml", "<QuickAction/>");
    write("applications/Sales.app-meta.xml", "<CustomApplication><tabs>DealHome</tabs></CustomApplication>");
    write("profiles/Admin.profile-meta.xml", "<Profile><quickAction>Opportunity.NewDeal</quickAction></Profile>");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const files = (...rel: string[]) => rel.map((r) => path.join(dir, "force-app/main/default", r));

  it("counts deep and basic changes and finds who mentions the basic ones", () => {
    const { result } = analyzeChange({
      projectDir: dir,
      files: files(
        "classes/Util.cls",
        "tabs/DealHome.tab-meta.xml",
        "quickActions/Opportunity.NewDeal.quickAction-meta.xml",
      ),
    });
    expect(result.coverage?.deep).toBe(1);
    expect(result.coverage?.basic).toBe(2);
    expect(result.coverage?.basicByType).toEqual([
      { type: "CustomTab", count: 1 },
      { type: "QuickAction", count: 1 },
    ]);
    const bySlot = Object.fromEntries(result.coverage?.mentions.map((m) => [m.component, m.files]) ?? []);
    expect(bySlot.DealHome).toEqual(["force-app/main/default/applications/Sales.app-meta.xml"]);
    expect(bySlot["Opportunity.NewDeal"]).toEqual(["force-app/main/default/profiles/Admin.profile-meta.xml"]);
    expect(result.findings.filter((f) => f.rule === "metadata-not-analyzed")).toHaveLength(2);
    expect(result.findings.find((f) => f.title.includes("DealHome"))?.severity).toBe("info");
  });

  it("says so in the report, and says nothing when everything is analyzed in depth", () => {
    const md = toMarkdown(
      analyzeChange({
        projectDir: dir,
        files: files("classes/Util.cls", "tabs/DealHome.tab-meta.xml"),
      }).result,
    );
    expect(md).toContain("Analyzed in depth: **1** of **2**");
    expect(md).toContain("CustomTab ×1");
    expect(md).toContain("### Not analyzed in depth");
    const only = analyzeChange({ projectDir: dir, files: files("classes/Util.cls") }).result;
    expect(only.coverage).toBeUndefined();
    expect(toMarkdown(only)).not.toContain("Analyzed in depth");
  });

  it("can be switched off like any rule", () => {
    writeFileSync(path.join(dir, ".preflight.json"), JSON.stringify({ rules: { "metadata-not-analyzed": "off" } }));
    const { result } = analyzeChange({
      projectDir: dir,
      files: files("tabs/DealHome.tab-meta.xml"),
    });
    expect(result.findings.filter((f) => f.rule === "metadata-not-analyzed")).toHaveLength(0);
    expect(result.coverage?.basic).toBe(1); // the summary still says it
  });
});
