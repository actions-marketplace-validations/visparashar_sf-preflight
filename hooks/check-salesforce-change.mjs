#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Claude Code PostToolUse hook: after an edit to Salesforce metadata, run `preflight analyze` on
 * the edited file and, when it finds high or medium risks, tell the agent so it can fix them
 * before moving on. Silent for anything else, and never blocks: errors exit 0.
 *
 * Reads the hook input (JSON) on stdin. Uses, in order: $SF_PREFLIGHT_CLI (a path to cli.js),
 * the project's own node_modules/sf-preflight, or `npx -y sf-preflight@<plugin version>`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const METADATA = /\.(cls|trigger|agent)$|-meta\.xml$|\.genAiPlannerBundle$/;
const MAX_LINES = 8;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** The SFDX project (folder with sfdx-project.json) that contains the file, if any. */
function projectOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(dir, "sfdx-project.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function pluginVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function runPreflight(project, args) {
  const local = path.join(project, "node_modules", "sf-preflight", "dist", "cli.js");
  const cli = process.env.SF_PREFLIGHT_CLI || (existsSync(local) ? local : undefined);
  const options = { cwd: project, encoding: "utf8", timeout: 110_000, stdio: ["ignore", "pipe", "ignore"] };
  if (cli) return execFileSync(process.execPath, [cli, ...args], options);
  const version = pluginVersion();
  const pkg = version ? `sf-preflight@${version}` : "sf-preflight";
  const windows = process.platform === "win32";
  return execFileSync(windows ? "npx.cmd" : "npx", ["-y", pkg, ...args], { ...options, shell: windows });
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }
  const raw = input?.tool_input?.file_path;
  if (typeof raw !== "string" || !METADATA.test(raw)) return;
  const file = path.resolve(input.cwd || process.cwd(), raw);
  const project = projectOf(file);
  if (!project || !existsSync(file)) return;

  let report;
  try {
    report = JSON.parse(runPreflight(project, ["analyze", "--files", file, "--format", "json"]));
  } catch {
    return; // not installed, offline, or not analysable: stay out of the way
  }
  const findings = (report.findings ?? []).filter((f) => f.severity === "high" || f.severity === "medium");
  if (!findings.length) return;

  const rel = path.relative(project, file).split(path.sep).join("/");
  const lines = findings.slice(0, MAX_LINES).map((f) => `- [${f.severity}] ${f.title} (${f.rule})`);
  if (findings.length > MAX_LINES) lines.push(`- …and ${findings.length - MAX_LINES} more`);
  const context = [
    `sf-preflight checked ${rel}: risk ${report.summary?.risk ?? "unknown"}.`,
    ...lines,
    "Fix high findings or explain to the user why they're acceptable; follow the sf-preflight skill (analyze the whole change and generate tests) before finishing.",
  ].join("\n");
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }),
  );
}

try {
  main();
} catch {
  // never interrupt the agent
}
process.exit(0);
