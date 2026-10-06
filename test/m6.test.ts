import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AnalysisResult,
  applyConfig,
  buildEvidence,
  canonicalJson,
  evaluateGate,
  evidenceToMarkdown,
  gateToMarkdown,
  globMatch,
  loadConfig,
  parseApprovals,
  parseConfig,
  run,
  toJunit,
  toMarkdown,
  type ValidationResult,
  verifyEvidence,
} from "../src/core/index.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const VR = `${SRC}/objects/Opportunity/validationRules/Require_Contract_Signed_Date.validationRule-meta.xml`;
const FIELD = `${SRC}/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml`;

const fieldResult = () => run({ projectDir: FIXTURE, files: [path.join(FIXTURE, FIELD)], config: false });

describe("config file", () => {
  it("accepts rule overrides, ignores and gate settings", () => {
    expect(
      parseConfig({
        $schema: "x",
        rules: { "legacy-workflow": "off", "dml-or-soql-in-loop": "high" },
        ignore: { paths: ["force-app/**/Legacy*.cls"] },
        gate: { failOn: "medium", aiAssistedApprovals: 2, requireAgentTests: true, requireTestsPassed: false },
      }),
    ).toEqual({
      rules: { "legacy-workflow": "off", "dml-or-soql-in-loop": "high" },
      ignore: { paths: ["force-app/**/Legacy*.cls"] },
      gate: { failOn: "medium", aiAssistedApprovals: 2, requireAgentTests: true, requireTestsPassed: false },
    });
  });

  it("rejects typos and bad values with the setting's name", () => {
    expect(() => parseConfig({ gates: {} }, "p.json")).toThrow('p.json: unknown setting "gates"');
    expect(() => parseConfig({ gate: { failon: "high" } })).toThrow('unknown setting "gate.failon"');
    expect(() => parseConfig({ rules: { "no-such-rule": "off" } })).toThrow('unknown rule "no-such-rule"');
    expect(() => parseConfig({ rules: { "legacy-workflow": "critical" } })).toThrow("must be one of high");
    expect(() => parseConfig({ gate: { failOn: "info" } })).toThrow('"gate.failOn" must be one of none');
    expect(() => parseConfig({ gate: { aiAssistedApprovals: 1.5 } })).toThrow("whole number");
    expect(() => parseConfig({ ignore: { paths: "x" } })).toThrow("list of glob patterns");
    expect(() => parseConfig([])).toThrow("expected a JSON object");
  });

  it("keeps the published JSON schema in line with the parser", () => {
    const schema = JSON.parse(readFileSync(path.resolve(__dirname, "../schema/preflight.schema.json"), "utf8"));
    expect(Object.keys(schema.properties).sort()).toEqual(["$schema", "gate", "ignore", "rules"]);
    const gateKeys = Object.keys(schema.properties.gate.properties);
    expect(gateKeys.sort()).toEqual(["aiAssistedApprovals", "failOn", "requireAgentTests", "requireTestsPassed"]);
    expect(schema.properties.gate.properties.failOn.enum).toEqual(["none", "low", "medium", "high"]);
    expect(schema.properties.rules.additionalProperties.enum).toEqual(["high", "medium", "low", "info", "off"]);
  });

  it("matches globs", () => {
    expect(globMatch("force-app/**/*.cls", "force-app/main/default/classes/A.cls")).toBe(true);
    expect(globMatch("force-app/**/*.cls", "force-app/A.cls")).toBe(true);
    expect(globMatch("force-app/*/A.cls", "force-app/main/default/A.cls")).toBe(false);
    expect(globMatch("**/Legacy?.cls", "x/y/Legacy1.cls")).toBe(true);
    expect(globMatch("./a/b.xml", "a/b.xml")).toBe(true);
    expect(globMatch("a/*", "a/b/c")).toBe(false);
    // Long inputs stay fast.
    const started = Date.now();
    globMatch("**/**/**/**/*x", `${"a/".repeat(200)}b`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("turns rules off, changes severities and ignores paths", () => {
    const result = fieldResult();
    expect(result.findings.some((f) => f.rule === "recursion-cycle")).toBe(true);
    const configured = applyConfig(result, {
      rules: { "recursion-cycle": "off", "after-save-self-update": "high" },
      ignore: { paths: [`${SRC}/classes/**`] },
    });
    expect(configured.findings.some((f) => f.rule === "recursion-cycle")).toBe(false);
    expect(configured.findings.find((f) => f.rule === "after-save-self-update")!.severity).toBe("high");
    expect(
      configured.findings.some((f) => f.files.length && f.files.every((x) => x.startsWith(`${SRC}/classes/`))),
    ).toBe(false);
    expect(configured.summary.findingsBySeverity.high).toBe(
      configured.findings.filter((f) => f.severity === "high").length,
    );
  });
});

describe("config discovery", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-m6-config-"));
    cpSync(FIXTURE, path.join(dir, "sfdx"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(path.join(dir, ".preflight.json"), JSON.stringify({ rules: { "recursion-cycle": "off" } }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds .preflight.json in the project, then the git root, and applies it in run()", () => {
    const project = path.join(dir, "sfdx");
    expect(loadConfig(project).file).toBe(path.join(dir, ".preflight.json"));
    const result = run({ projectDir: project, files: [path.join(project, FIELD)] });
    expect(result.config).toEqual({ file: "../.preflight.json" });
    expect(result.findings.some((f) => f.rule === "recursion-cycle")).toBe(false);
    expect(toMarkdown(result)).toContain("_Policy: `../.preflight.json`_");
    const ignored = run({ projectDir: project, files: [path.join(project, FIELD)], config: false });
    expect(ignored.config).toBeUndefined();
    expect(ignored.findings.some((f) => f.rule === "recursion-cycle")).toBe(true);
    writeFileSync(path.join(project, ".preflight.json"), JSON.stringify({ gate: { failOn: "low" } }));
    expect(loadConfig(project).config).toEqual({ gate: { failOn: "low" } });
    expect(() => loadConfig(project, path.join(dir, "missing.json"))).toThrow("Config file not found");
    writeFileSync(path.join(project, ".preflight.json"), "{ nope");
    expect(() => loadConfig(project)).toThrow("invalid JSON");
  });
});

const validation = (status: "passed" | "failed"): ValidationResult => ({
  org: "dev",
  orgKind: "developer",
  status,
  tests: [
    { method: "a", outcome: "pass" },
    { method: "b", outcome: status === "passed" ? "pass" : "fail", message: "boom" },
  ],
  componentErrors: [],
  coverageWarnings: [],
});

describe("quality gate", () => {
  const withAi = (r: AnalysisResult, ai: number): AnalysisResult => ({
    ...r,
    provenance: { range: "a..b", commits: 2, aiAssistedCommits: ai, tools: ai ? ["Claude"] : [], details: [] },
  });

  it("fails on findings at or above the threshold", () => {
    const r = fieldResult();
    const gate = evaluateGate({ result: r });
    expect(gate.status).toBe("fail");
    expect(gate.failOn).toBe("high");
    expect(gate.checks[0]!.detail).toMatch(/^\d+ high: Automation cycle/);
    expect(evaluateGate({ result: r, config: { failOn: "none" } }).status).toBe("pass");
  });

  it("requires approvals for AI-assisted changes", () => {
    const r = withAi(fieldResult(), 1);
    const config = { failOn: "none" as const, aiAssistedApprovals: 2 };
    const unknown = evaluateGate({ result: r, config });
    expect(unknown.checks[1]).toMatchObject({ id: "ai-approvals", status: "fail" });
    expect(unknown.checks[1]!.detail).toContain("no approval data was provided");
    const one = evaluateGate({ result: r, config, approvals: [{ reviewer: "alice" }, { reviewer: "alice" }] });
    expect(one.checks[1]).toMatchObject({ status: "fail", detail: "1 AI-assisted commit(s); 1 approval(s) (alice)." });
    const two = evaluateGate({ result: r, config, approvals: parseApprovals(["alice", { reviewer: "bob" }]) });
    expect(two.status).toBe("pass");
    expect(evaluateGate({ result: withAi(fieldResult(), 0), config }).checks[1]!.detail).toBe(
      "No AI-assisted commits.",
    );
    expect(evaluateGate({ result: fieldResult(), config }).checks[1]!.detail).toBe("No commit range was analyzed.");
  });

  it("requires Testing Center coverage for affected agent actions", () => {
    const gate = evaluateGate({ result: fieldResult(), config: { failOn: "none", requireAgentTests: true } });
    expect(gate.checks[1]).toMatchObject({
      id: "agent-tests",
      status: "fail",
      detail: "Not covered: Sales Agent › Close Opportunity.",
    });
  });

  it("requires the generated tests to have passed", () => {
    const config = { failOn: "none" as const, requireTestsPassed: true };
    const r = fieldResult();
    expect(evaluateGate({ result: r, config }).checks[1]!.detail).toContain("weren't run");
    expect(evaluateGate({ result: r, config, validation: validation("failed") }).checks[1]).toMatchObject({
      status: "fail",
      detail: "1 of 2 passed in dev.",
    });
    expect(evaluateGate({ result: r, config, validation: validation("passed") }).status).toBe("pass");
  });

  it("renders a table and validates approval files", () => {
    const md = gateToMarkdown(evaluateGate({ result: fieldResult() }));
    expect(md).toContain("### Quality gate: ❌ failed");
    expect(md).toContain("| No findings at or above high | ❌ fail |");
    expect(() => parseApprovals({})).toThrow("expected a JSON array");
    expect(() => parseApprovals([42], "a.json")).toThrow("a.json: entry 1 must be a reviewer name");
  });
});

describe("evidence pack", () => {
  let repo: string;
  let project: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
      cwd: repo,
      stdio: "pipe",
    })
      .toString()
      .trim();
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-m6-evidence-"));
    project = path.join(repo, "sfdx");
    cpSync(FIXTURE, project, { recursive: true });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://someone:ghp_secret@github.com/acme/sf-app.git");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const vr = path.join(project, VR);
    writeFileSync(vr, readFileSync(vr, "utf8").replace("Closed Won", "Closed  Won"));
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Jane Doe",
        "-c",
        "user.email=jane@example.com",
        "commit",
        "-q",
        "-am",
        "Tighten rule\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ],
      { cwd: repo },
    );
    writeFileSync(path.join(repo, ".preflight.json"), JSON.stringify({ gate: { aiAssistedApprovals: 1 } }));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const make = () => {
    const result = run({ projectDir: project, base: "HEAD~1", head: "HEAD" });
    const { config } = loadConfig(project);
    const approvals = parseApprovals([{ reviewer: "alice", submittedAt: "2026-10-06T10:00:00Z" }]);
    const gate = evaluateGate({ result, config: config.gate, approvals, validation: validation("passed") });
    return buildEvidence({
      result,
      gate,
      version: "9.9.9",
      approvals,
      tests: { tests: [{ method: "a", kind: "bulk", title: "A" }], validation: validation("passed") },
      configFile: result.config?.file,
    });
  };

  it("records what changed, who wrote it, findings, tests, approvals and the gate", () => {
    const e = make();
    expect(e).toMatchObject({
      evidenceVersion: 1,
      predicateType: "https://github.com/visparashar/sf-preflight/evidence/v1",
      tool: { name: "sf-preflight", version: "9.9.9" },
      repository: { url: "https://github.com/acme/sf-app.git", projectPath: "sfdx" },
      change: {
        base: { ref: "HEAD~1", sha: git("rev-parse", "HEAD~1") },
        head: { ref: "HEAD", sha: git("rev-parse", "HEAD") },
        authorship: { commits: 1, aiAssistedCommits: 1, tools: ["Claude"] },
      },
      approvals: [{ reviewer: "alice", submittedAt: "2026-10-06T10:00:00Z" }],
      tests: {
        generated: [{ method: "a", kind: "bulk", title: "A" }],
        validation: { org: "dev", passed: 2, failed: 0 },
      },
      config: { file: ".preflight.json" },
    });
    expect(e.change.authorship!.details[0]).toMatchObject({ author: "Jane Doe", subject: "Tighten rule" });
    const [component] = e.change.components;
    expect(component).toMatchObject({ changeType: "modified", type: "ValidationRule", file: VR });
    expect(component!.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(path.join(project, VR)))
        .digest("hex"),
    );
    expect(e.gate.checks.map((c) => `${c.id}:${c.status}`)).toEqual(["findings:fail", "ai-approvals:pass"]);
    const text = JSON.stringify(e);
    expect(text).not.toContain("ghp_secret");
    expect(text).not.toContain("jane@example.com");
  });

  it("carries a digest that detects any change", () => {
    const e = make();
    expect(verifyEvidence(e)).toBe(true);
    expect(verifyEvidence({ ...e, analysis: { ...e.analysis, risk: "low" } })).toBe(false);
    expect(verifyEvidence(JSON.parse(JSON.stringify(e)))).toBe(true);
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it("summarizes the evidence", () => {
    const md = evidenceToMarkdown(make());
    expect(md).toContain("## Change evidence");
    expect(md).toMatch(/\| Change \| `HEAD~1` \([0-9a-f]{7}\) → `HEAD` \([0-9a-f]{7}\) \|/);
    expect(md).toContain("| Authorship | 1 commit(s), 1 AI-assisted (Claude) |");
    expect(md).toContain("| Tests | 1 generated; 2 passed, 0 failed in dev |");
    expect(md).toContain("| Approvals | alice |");
    expect(md).toContain("| Policy | `.preflight.json` |");
  });

  it("hashes file bytes from git and notes shallow clones", () => {
    expect(make().change.authorship!.complete).toBe(true);
    // A Latin-1 file (not valid UTF-8): the digest must match its bytes, not a decoded copy.
    const bin = `${SRC}/classes/Legacy.cls`;
    const bytes = Buffer.concat([
      Buffer.from("public class Legacy { // caf"),
      Buffer.from([0xe9]),
      Buffer.from(" }\n"),
    ]);
    mkdirSync(path.join(project, `${SRC}/classes`), { recursive: true });
    writeFileSync(path.join(project, bin), bytes);
    git("add", ".");
    git("-c", "user.name=Jane Doe", "-c", "user.email=jane@example.com", "commit", "-q", "-m", "Add logo");
    const result = run({ projectDir: project, base: "HEAD~1", head: "HEAD" });
    const e = buildEvidence({ result, gate: evaluateGate({ result }), version: "1" });
    expect(e.change.components.find((c) => c.file === bin)?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    const shallow = mkdtempSync(path.join(tmpdir(), "sf-preflight-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "2", `file://${repo}`, shallow]);
      const r = run({ projectDir: path.join(shallow, "sfdx"), base: "HEAD~1", head: "HEAD" });
      const pack = buildEvidence({ result: r, gate: evaluateGate({ result: r }), version: "1" });
      expect(pack.change.authorship!.complete).toBe(false);
      expect(evidenceToMarkdown(pack)).toContain("shallow clone, so earlier commits may be missing");
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe("JUnit output", () => {
  it("reports gate checks and findings as test cases", () => {
    const result = fieldResult();
    result.gate = evaluateGate({ result, config: { failOn: "medium" } });
    const xml = toJunit(result);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="sf-preflight"')).toBe(true);
    const failures = result.findings.filter((f) => f.severity === "high" || f.severity === "medium").length;
    expect(xml).toContain(
      `<testsuite name="sf-preflight.findings" tests="${result.findings.length}" failures="${failures}">`,
    );
    expect(xml).toContain('<testsuite name="sf-preflight.gate" tests="1" failures="1">');
    expect(xml).toContain('classname="sf-preflight.recursion-cycle"');
    expect((xml.match(/<testcase /g) ?? []).length).toBe(result.findings.length + 1);
  });

  it("escapes XML and handles changes without findings", () => {
    const r = fieldResult();
    r.findings = [{ rule: "x", severity: "high", title: 'A & B <c> "d"', detail: "e\u0001f", files: ["g&h.xml"] }];
    const xml = toJunit(r, "high");
    expect(xml).toContain('name="[high] A &amp; B &lt;c&gt; &quot;d&quot;" file="g&amp;h.xml"');
    expect(xml).toContain(">ef</failure>");
    r.findings = [];
    expect(toJunit(r)).toContain('<testcase classname="sf-preflight.findings" name="No findings"></testcase>');
  });
});
