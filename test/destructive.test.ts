// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDestructiveManifest, sourcePathFor } from "../src/core/destructive.js";
import { analyzeChange } from "../src/core/index.js";
import { classifyPath } from "../src/core/project.js";

const manifest = (types: Record<string, string[]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">${Object.entries(
    types,
  )
    .map(
      ([name, members]) =>
        `<types>${members.map((m) => `<members>${m}</members>`).join("")}<name>${name}</name></types>`,
    )
    .join("")}<version>62.0</version></Package>`;

describe("destructive manifests", () => {
  it("reads members by type and skips wildcards", () => {
    expect(parseDestructiveManifest(manifest({ ApexClass: ["A", "*"], CustomField: ["Account.F__c"] }))).toEqual([
      { type: "ApexClass", member: "A" },
      { type: "CustomField", member: "Account.F__c" },
    ]);
  });

  it("types each member like the source file it would have", () => {
    const cases: [string, string, string, string][] = [
      ["CustomField", "Account.Foo__c", "CustomField", "Account.Foo__c"],
      ["ValidationRule", "Account.Rule", "ValidationRule", "Account.Rule"],
      ["CustomObject", "Invoice__c", "CustomObject", "Invoice__c"],
      ["ApexClass", "Foo", "ApexClass", "Foo"],
      ["Flow", "F", "Flow", "F"],
      ["LightningComponentBundle", "myCmp", "LightningComponentBundle", "myCmp"],
      ["StaticResource", "lib", "StaticResource", "lib"],
      ["EmailTemplate", "Folder/Tpl", "EmailTemplate", "Folder/Tpl"],
      ["NamedCredential", "Stripe", "NamedCredential", "Stripe"],
    ];
    for (const [type, member, expectType, expectName] of cases) {
      const c = classifyPath(sourcePathFor(type, member)!);
      expect([c.metadataType ?? c.type, c.name]).toEqual([expectType, expectName]);
    }
    expect(sourcePathFor("NoSuchType", "x")).toBeUndefined();
  });

  describe("in the analysis", () => {
    let dir: string;
    const base = "force-app/main/default/";
    const write = (rel: string, body: string) => {
      const f = path.join(dir, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, body);
    };
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "preflight-destructive-"));
      writeFileSync(
        path.join(dir, "sfdx-project.json"),
        JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
      );
      write(`${base}classes/Caller.cls`, "public class Caller { void go(){ Helper.run(); } }");
      write(`${base}pages/Home.page`, '<apex:page><apex:includeScript value="{!$Resource.chart_lib}"/></apex:page>');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("checks each deleted member for references, pointing at the manifest", () => {
      write(
        "manifest/destructiveChanges.xml",
        manifest({ ApexClass: ["Helper"], StaticResource: ["chart_lib"], Bogus: ["x"] }),
      );
      const { result } = analyzeChange({ projectDir: dir, files: [path.join(dir, "manifest/destructiveChanges.xml")] });
      expect(result.changes.map((c) => [c.changeType, c.component.name, c.component.file])).toEqual([
        ["deleted", "Helper", "manifest/destructiveChanges.xml"],
        ["deleted", "chart_lib", "manifest/destructiveChanges.xml"],
      ]);
      const cls = result.findings.find((f) => f.rule === "deleted-still-referenced");
      expect(cls?.files).toEqual(["manifest/destructiveChanges.xml", `${base}classes/Caller.cls`]);
      const res = result.findings.find((f) => f.rule === "deleted-still-named");
      expect(res?.files).toEqual(["manifest/destructiveChanges.xml", `${base}pages/Home.page`]);
      expect(result.warnings.join("\n")).toContain("Bogus");
    });

    it("reads a manifest outside the package directories in a git diff", () => {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "base");
      write("manifest/destructiveChangesPost.xml", manifest({ ApexClass: ["Helper"] }));
      const { result } = analyzeChange({ projectDir: dir, base: "HEAD" });
      expect(result.findings.some((f) => f.rule === "deleted-still-referenced")).toBe(true);
    });
  });
});
