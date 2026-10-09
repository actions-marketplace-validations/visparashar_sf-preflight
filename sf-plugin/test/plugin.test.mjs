// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { translate } = await import(pathToFileURL(path.join(here, "../dist/passthrough.js")).href);
const run = path.join(here, "run.mjs");

/** Runs `sf <args>` through the plugin, with `cli` standing in for the sf-preflight CLI. */
const sf = (cli, ...args) =>
  spawnSync(process.execPath, [run, ...args], { encoding: "utf8", env: { ...process.env, SF_PREFLIGHT_CLI: cli } });

const dir = mkdtempSync(path.join(tmpdir(), "sf-plugin-"));
const echo = path.join(dir, "echo.mjs");
writeFileSync(echo, "console.log(JSON.stringify(process.argv.slice(2)));");
const fail = path.join(dir, "fail.mjs");
writeFileSync(fail, "process.exit(2);");

test("translate maps sf's org and json flags onto the CLI's", () => {
  const on = { hasFormat: true, org: true };
  assert.deepEqual(translate(["-o", "box", "--base", "main"], on), ["--org", "box", "--base", "main"]);
  assert.deepEqual(translate(["--target-org", "box"], on), ["--org", "box"]);
  assert.deepEqual(translate(["--target-org=box"], on), ["--org", "box"]);
  assert.deepEqual(translate(["--json"], on), ["--format", "json"]);
  assert.deepEqual(translate(["--json", "--format", "sarif"], on), ["--format", "sarif"]);
  assert.deepEqual(translate(["--json"], { hasFormat: false, org: false }), []);
  assert.deepEqual(translate(["-o", "report.json"], { hasFormat: false, org: false }), ["-o", "report.json"]);
  assert.deepEqual(translate(["--", "-o", "x"], on), ["--", "-o", "x"]);
});

test("a command passes its flags to the CLI, including ones it doesn't list", () => {
  const r = sf(
    echo,
    "preflight",
    "analyze",
    "--base",
    "origin/main",
    "--gate",
    "--md-out",
    "r.md",
    "-o",
    "box",
    "--json",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [
    "analyze",
    "--base",
    "origin/main",
    "--gate",
    "--md-out",
    "r.md",
    "--org",
    "box",
    "--format",
    "json",
  ]);
});

test("the CLI's exit code reaches the shell (the gate exits 2)", () => {
  assert.equal(sf(fail, "preflight", "analyze", "--gate").status, 2);
});

test("evidence keeps -o for its --out", () => {
  const r = sf(echo, "preflight", "evidence", "-o", "e.json");
  assert.deepEqual(JSON.parse(r.stdout), ["evidence", "-o", "e.json"]);
});

test("--help lists the commands' flags", () => {
  const r = sf(echo, "preflight", "tests", "--help");
  assert.match(r.stdout, /--validate/);
  assert.match(r.stdout, /--target-org/);
});

test("runs the real CLI end to end", () => {
  const cli = path.join(here, "../../dist/cli.js");
  const sample = path.join(here, "../../fixtures/sample-org");
  const field = path.join(
    sample,
    "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml",
  );
  const r = sf(cli, "preflight", "analyze", "--project", sample, "--files", field, "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).findings.length > 0);
});

test("lists every command under the preflight topic", () => {
  const r = sf(echo, "preflight", "--help");
  for (const c of [
    "analyze",
    "tests",
    "agents",
    "agent-tests",
    "incidents",
    "monitor",
    "rollback",
    "explain",
    "evidence",
  ]) {
    assert.match(r.stdout, new RegExp(`preflight ${c}`));
  }
});
