// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledSkillDir, installSkill } from "../src/core/skill.js";

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, "skills", "sf-preflight");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const json = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

/** Frontmatter as flat `key: value` pairs (plus nested `metadata`), enough for the spec checks. */
function frontmatter(text: string): { fields: Record<string, string>; metadata: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  for (const line of m[1]!.split("\n")) {
    const nested = /^ {2}([a-z-]+): "?(.*?)"?$/.exec(line);
    if (inMetadata && nested) {
      metadata[nested[1]!] = nested[2]!;
      continue;
    }
    const top = /^([a-z-]+):\s?(.*)$/.exec(line);
    if (!top) continue;
    inMetadata = top[1] === "metadata";
    fields[top[1]!] = top[2]!;
  }
  return { fields, metadata, body: m[2]! };
}

describe("the agent skill", () => {
  const text = readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
  const { fields, metadata, body } = frontmatter(text);

  it("follows the Agent Skills specification", () => {
    // https://agentskills.io/specification
    expect(fields.name).toBe(path.basename(SKILL));
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fields.name!.length).toBeLessThanOrEqual(64);
    expect(fields.description!.length).toBeGreaterThan(0);
    expect(fields.description!.length).toBeLessThanOrEqual(1024);
    expect(fields.compatibility!.length).toBeLessThanOrEqual(500);
    // Only the standard fields, so every Agent Skills client reads it the same way.
    expect(Object.keys(fields).sort()).toEqual(["compatibility", "description", "license", "metadata", "name"]);
    expect(body.split("\n").length).toBeLessThan(500);
  });

  it("links only to files it ships, one level deep", () => {
    const links = [...text.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(path.join(SKILL, link))).toBe(true);
  });

  it("names every MCP tool the server has, and every finding rule", () => {
    const mcp = readFileSync(path.join(ROOT, "src", "mcp.ts"), "utf8");
    const tools = [...mcp.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(text).toContain(tool);
    const rules = readFileSync(path.join(ROOT, "docs", "RULES.md"), "utf8");
    const ids = [...rules.matchAll(/^\| \[`([a-z-]+)`\]/gm)].map((m) => m[1]!);
    const findings = readFileSync(path.join(SKILL, "references", "findings.md"), "utf8");
    for (const id of ids) expect(findings).toContain(`\`${id}\``);
  });

  it("matches the package version, as does the plugin", () => {
    expect(metadata.version).toBe(pkg.version);
    const plugin = json(".claude-plugin/plugin.json");
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.mcpServers["sf-preflight"].args).toEqual([
      "-y",
      `sf-preflight@${pkg.version}`,
      "mcp",
      "--root",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code substitutes it, not JavaScript
      "${CLAUDE_PROJECT_DIR}",
    ]);
    const market = json(".claude-plugin/marketplace.json");
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "./" })]);
    expect(pkg.files).toContain("skills");
  });

  it("installs into the folders agents read, and only updates with force", () => {
    const project = mkdtempSync(path.join(tmpdir(), "preflight-skill-"));
    try {
      expect(bundledSkillDir()).toBe(SKILL);
      const written = installSkill({ projectDir: project });
      expect(written).toEqual([
        path.join(project, ".agents", "skills", "sf-preflight"),
        path.join(project, ".claude", "skills", "sf-preflight"),
      ]);
      for (const dir of written) {
        expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(text);
        expect(existsSync(path.join(dir, "references", "findings.md"))).toBe(true);
      }
      expect(() => installSkill({ projectDir: project })).toThrow("Pass --force to update it");
      writeFileSync(path.join(written[0]!, "SKILL.md"), "old");
      installSkill({ projectDir: project, force: true });
      expect(readFileSync(path.join(written[0]!, "SKILL.md"), "utf8")).toBe(text);
      const custom = installSkill({ dirs: [path.join(project, ".github", "skills")] });
      expect(custom).toEqual([path.join(project, ".github", "skills", "sf-preflight")]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("the Claude Code edit hook", () => {
  const hooks = json("hooks/hooks.json");
  const script = path.join(ROOT, "hooks", "check-salesforce-change.mjs");

  it("runs after edits and points at a script the plugin ships", () => {
    const entry = hooks.hooks.PostToolUse[0];
    expect(entry.matcher).toBe("Edit|Write|MultiEdit");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code substitutes it, not JavaScript
    expect(entry.hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/check-salesforce-change.mjs");
    expect(existsSync(script)).toBe(true);
  });

  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-hook-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), '{"packageDirectories":[{"path":"force-app"}]}');
    mkdirSync(path.join(dir, "force-app", "classes"), { recursive: true });
    const cls = path.join(dir, "force-app", "classes", "Handler.cls");
    writeFileSync(cls, "public class Handler {}");
    // A stand-in for the CLI that reports what a real analysis might.
    const cli = path.join(dir, "fake-cli.mjs");
    writeFileSync(
      cli,
      `const args = process.argv.slice(2);
if (process.env.FAKE_FAIL) process.exit(1);
process.stdout.write(JSON.stringify({
  summary: { risk: process.env.FAKE_RISK || "high" },
  args,
  findings: process.env.FAKE_RISK === "low" ? [{ severity: "low", rule: "x", title: "minor" }] : [
    { severity: "high", rule: "recursion-cycle", title: "Automation cycle: Contact → Account → Contact" },
    { severity: "medium", rule: "automation-density", title: "Many automations" },
    { severity: "info", rule: "flow-inactive", title: "Inactive flow" },
  ],
}));`,
    );
    return { dir, cls, cli };
  };
  const run = (input: unknown, env: Record<string, string>) =>
    execFileSync(process.execPath, [script], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("tells the agent about high and medium findings in the file it edited", () => {
    const { dir, cls, cli } = setup();
    try {
      const out = JSON.parse(
        run({ tool_name: "Edit", cwd: dir, tool_input: { file_path: cls } }, { SF_PREFLIGHT_CLI: cli }),
      );
      expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      const context: string = out.hookSpecificOutput.additionalContext;
      expect(context).toContain("sf-preflight checked force-app/classes/Handler.cls: risk high.");
      expect(context).toContain("- [high] Automation cycle: Contact → Account → Contact (recursion-cycle)");
      expect(context).toContain("- [medium] Many automations (automation-density)");
      expect(context).not.toContain("Inactive flow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent for other files, low risk, projects without sfdx-project.json and failures", () => {
    const { dir, cls, cli } = setup();
    try {
      const edit = (file: string) => ({ tool_name: "Write", cwd: dir, tool_input: { file_path: file } });
      expect(run(edit(path.join(dir, "README.md")), { SF_PREFLIGHT_CLI: cli })).toBe("");
      expect(run(edit(cls), { SF_PREFLIGHT_CLI: cli, FAKE_RISK: "low" })).toBe("");
      expect(run(edit(cls), { SF_PREFLIGHT_CLI: cli, FAKE_FAIL: "1" })).toBe("");
      rmSync(path.join(dir, "sfdx-project.json"));
      expect(run(edit(cls), { SF_PREFLIGHT_CLI: cli })).toBe("");
      expect(execFileSync(process.execPath, [script], { input: "not json", encoding: "utf8" })).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
