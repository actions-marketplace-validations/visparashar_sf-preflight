// SPDX-License-Identifier: Apache-2.0
// Activates the built extension (dist/extension.js) against a fake `vscode` module and a real git
// repository, and checks what it publishes: problems, the blast-radius tree, the status bar and the
// MCP server definition. Run after `npm run build`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const vscode = require("./fake-vscode.cjs");

// Resolve `vscode` to the fake for the bundle.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return path.join(here, "fake-vscode.cjs");
  return resolve.call(this, request, ...rest);
};

const fixture = path.resolve(ext, "..", "fixtures", "sample-org");
const SRC = "force-app/main/default";
let repo;
let extension;
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" }).toString();

async function until(check, what, ms = 60_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms)
      throw new Error(`Timed out waiting for ${what}. Log: ${(vscode.__state.log ?? []).join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  assert.ok(existsSync(path.join(ext, "dist", "extension.js")), "run `npm run build` first");
  repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-vscode-"));
  cpSync(fixture, repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  // An uncommitted change, as while editing: the trigger handler.
  const handler = path.join(repo, SRC, "classes", "ContactTriggerHandler.cls");
  writeFileSync(handler, `${readFileSync(handler, "utf8")}\n// edited\n`);
  vscode.__state.root = repo;
  extension = require(path.join(ext, "dist", "extension.js"));
  await extension.activate({ subscriptions: [], extensionPath: ext, extension: { packageJSON: { version: "9.9.9" } } });
  await until(() => vscode.__state.diagnostics.size > 0, "problems");
});

after(() => {
  extension?.deactivate();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test("finds the project and registers its commands", () => {
  assert.equal(vscode.__state.context["sfPreflight.hasProject"], true);
  for (const id of [
    "sfPreflight.analyze",
    "sfPreflight.chooseBase",
    "sfPreflight.showReport",
    "sfPreflight.explainSaveOrder",
    "sfPreflight.generateTests",
    "sfPreflight.installSkill",
  ]) {
    assert.ok(vscode.__state.commands.has(id), id);
  }
});

test("puts findings in the Problems panel, on their files and lines", () => {
  const at = (rel) => vscode.__state.diagnostics.get(path.join(repo, SRC, rel)) ?? [];
  // The changed class: DML inside a loop, at its line (7, 0-based 6).
  const loop = at("classes/ContactTriggerHandler.cls").find((d) => d.code.value === "dml-or-soql-in-loop");
  assert.ok(loop, "DML in a loop on the handler");
  assert.equal(loop.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(loop.range.start.line, 6);
  assert.equal(loop.source, "sf-preflight");
  assert.match(loop.code.target.toString(), /RULES\.md#dml-or-soql-in-loop$/);
  // The cycle it sets off, on the trigger and the flow involved, each pointing at the other.
  const cycle = at("triggers/ContactTrigger.trigger").find((d) => d.code.value === "recursion-cycle");
  assert.ok(cycle, "the recursion cycle on the trigger");
  assert.ok(at("flows/Account_Sync_Tier_To_Contacts.flow-meta.xml").some((d) => d.code.value === "recursion-cycle"));
  assert.equal(cycle.relatedInformation.length, 1);
  // No remote here, so it compares with the local default branch from where HEAD left it.
  assert.ok((vscode.__state.log ?? []).some((l) => l.endsWith("vs main")));
});

test("shows the blast radius and the status", () => {
  const tree = vscode.__state.trees.get("sfPreflight.blastRadius");
  const top = tree.getChildren();
  assert.match(top[0].label, /^Risk: high/);
  const labels = top.map((n) => n.label);
  assert.ok(labels.includes("Findings"));
  assert.ok(labels.includes("What runs"));
  const findings = top.find((n) => n.label === "Findings");
  const item = tree.getTreeItem(findings.children[0]);
  assert.equal(item.command.command, "vscode.open");
  assert.match(vscode.__state.status.text, /Preflight: [1-9]\d* high/);
});

test("offers the bundled MCP server to agent mode", () => {
  const provider = vscode.__state.mcpProviders.get("sfPreflight.mcp");
  const [def] = provider.provideMcpServerDefinitions();
  assert.equal(def.label, "sf-preflight");
  assert.equal(def.command, process.execPath);
  assert.ok(existsSync(def.args[0]) && def.args[0].endsWith(path.join("dist", "mcp-server.js")));
  assert.deepEqual(def.args.slice(1), ["--root", repo]);
  assert.equal(def.env.ELECTRON_RUN_AS_NODE, "1");
  // The extension's own version, so an update refreshes the editor's cached tool list.
  assert.equal(def.version, "9.9.9");
});

test("installs the agent skill from the copy it bundles", async () => {
  await vscode.__state.commands.get("sfPreflight.installSkill")();
  for (const dir of [".agents", ".claude"]) {
    assert.ok(existsSync(path.join(repo, dir, "skills", "sf-preflight", "SKILL.md")), dir);
  }
});

const runs = () => (vscode.__state.log ?? []).filter((l) => / risk \w+,/.test(l)).length;

test("runs one analysis at a time, and once more for changes made meanwhile", async () => {
  const before = runs();
  const analyze = vscode.__state.commands.get("sfPreflight.analyze");
  await Promise.all([analyze(), analyze(), analyze()]);
  // The first run, plus one more for the requests that came while it ran: never three.
  assert.ok(runs() - before >= 1 && runs() - before <= 2, `${runs() - before} runs`);
});

test("analyzes again when metadata changes outside the editor", async () => {
  const before = runs();
  const watcher = vscode.__state.watchers.find((w) => w.pattern.includes("cls"));
  watcher.change.fire(vscode.Uri.file(path.join(repo, SRC, "classes", "ContactTriggerHandler.cls")));
  // Not for files that aren't metadata.
  watcher.change.fire(vscode.Uri.file(path.join(repo, "README.json")));
  await until(() => runs() > before, "a run after the change", 20_000);
  const head = vscode.__state.watchers.find((w) => w.pattern.includes(".git/HEAD"));
  const afterChange = runs();
  head.change.fire(vscode.Uri.file(path.join(repo, ".git", "HEAD")));
  await until(() => runs() > afterChange, "a run after a checkout", 20_000);
});

test("generates tests that don't count as part of the change", async () => {
  vscode.__state.answer = (_msg, _opts, ...items) => items.find((i) => i === "Generate");
  await vscode.__state.commands.get("sfPreflight.generateTests")();
  vscode.__state.answer = undefined;
  assert.ok((vscode.__state.opened ?? []).some((f) => f.endsWith("PreflightChangeTest.cls")));
  const before = runs();
  await vscode.__state.commands.get("sfPreflight.analyze")();
  await until(() => runs() > before, "a run after generating");
  const tree = vscode.__state.trees.get("sfPreflight.blastRadius");
  const changed = tree.getChildren().find((n) => n.label === "Changed components");
  assert.deepEqual(
    changed.children.map((c) => c.label),
    ["ContactTriggerHandler"],
  );
});
