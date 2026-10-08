// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";
import { installSkill } from "../src/core/skill.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");

describe("changes outside the package directories", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "preflight-pkgdirs-"));
    cpSync(FIXTURE, repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // Generated tests and a script: in the project, but not in a package directory.
    mkdirSync(path.join(repo, "preflight-tests", "classes"), { recursive: true });
    writeFileSync(path.join(repo, "preflight-tests", "classes", "PreflightChangeTest.cls"), "@IsTest class X {}");
    writeFileSync(path.join(repo, "scripts.cls"), "public class Script {}");
    // And a real change inside force-app.
    writeFileSync(
      path.join(repo, "force-app", "main", "default", "classes", "NewHelper.cls"),
      "public class NewHelper {}",
    );
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("leaves them out of a git diff, and says so", () => {
    const { result } = analyzeChange({ projectDir: repo, base: "HEAD", config: false });
    expect(result.changes.map((c) => c.component.name)).toEqual(["NewHelper"]);
    expect(result.ignoredFiles).toEqual(
      expect.arrayContaining(["preflight-tests/classes/PreflightChangeTest.cls", "scripts.cls"]),
    );
  });

  it("still analyzes files named explicitly", () => {
    const { result } = analyzeChange({
      projectDir: repo,
      files: [path.join(repo, "preflight-tests", "classes", "PreflightChangeTest.cls")],
      config: false,
    });
    expect(result.changes.map((c) => c.component.name)).toEqual(["PreflightChangeTest"]);
  });
});

describe.skipIf(process.platform === "win32")("installing the skill through a symbolic link", () => {
  it("refuses, so a committed link can't redirect the copy outside the project", () => {
    const project = mkdtempSync(path.join(tmpdir(), "preflight-skilllink-"));
    const outside = mkdtempSync(path.join(tmpdir(), "preflight-outside-"));
    try {
      symlinkSync(outside, path.join(project, ".claude"));
      expect(() => installSkill({ projectDir: project })).toThrow("symbolic link");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
