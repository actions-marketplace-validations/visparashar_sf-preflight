// SPDX-License-Identifier: Apache-2.0
// The report viewer (web/) reads the CLI's JSON in the browser. These tests hold its file detection
// and digest check to the library's own output, so the two can't drift apart.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEvidence, evaluateGate, evidenceDigest, run, verifyEvidence } from "../src/core/index.js";
import { detect, normalizeReport } from "../web/src/lib/detect.js";
import { checkDigest } from "../web/src/lib/digest.js";
import { checkLink, isPrivateHost } from "../web/src/lib/links.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const FIELD = "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";

/** What `--format json` writes, read back as the viewer reads it. */
const asJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function sample() {
  const result = run({ projectDir: FIXTURE, files: [path.join(FIXTURE, FIELD)] });
  const evidence = buildEvidence({ result, gate: evaluateGate({ result }), version: "0.0.0-test" });
  return { report: asJson(result), evidence: asJson(evidence) };
}

describe("web viewer: detecting files", () => {
  it("recognizes an analysis report and an evidence pack", () => {
    const { report, evidence } = sample();
    const r = detect(report);
    expect(r.kind).toBe("report");
    if (r.kind === "report") {
      expect(r.newer).toBe(false);
      expect(r.report.findings.length).toBe(report.findings.length);
      expect(r.report.summary.risk).toBe(report.summary.risk);
    }
    const e = detect(evidence);
    expect(e.kind).toBe("evidence");
  });

  it("fills lists an older report leaves out", () => {
    const { report } = sample();
    const { agents: _a, coverage: _c, warnings: _w, references: _r, ...older } = report;
    const r = normalizeReport(older as unknown as Record<string, unknown>);
    expect(r?.agents).toEqual([]);
    expect(r?.warnings).toEqual([]);
    expect(r?.references).toEqual([]);
  });

  it("says what to open instead of other files", () => {
    const sarif = detect({ version: "2.1.0", runs: [] });
    expect(sarif.kind === "unsupported" && sarif.reason).toMatch(/SARIF/);
    const tests = detect({ org: "dev", orgKind: "sandbox", status: "passed", tests: [], componentErrors: [] });
    expect(tests.kind === "unsupported" && tests.reason).toMatch(/preflight tests --validate/);
    expect(detect([1, 2]).kind).toBe("unsupported");
    expect(detect({ schemaVersion: 1, summary: {} }).kind).toBe("unsupported");
  });
});

describe("web viewer: evidence digest", () => {
  it("computes the same digest as the library", async () => {
    const { evidence } = sample();
    expect(verifyEvidence(evidence)).toBe(true);
    const check = await checkDigest(evidence);
    expect(check.computed).toBe(evidenceDigest(evidence));
    expect(check.recorded).toBe(evidence.digest.value);
    expect(check.matches).toBe(true);
  });

  it("notices an edit and a missing digest", async () => {
    const { evidence } = sample();
    const edited = {
      ...evidence,
      gate: { ...evidence.gate, status: evidence.gate.status === "pass" ? "fail" : "pass" },
    };
    expect((await checkDigest(edited)).matches).toBe(false);
    expect(verifyEvidence(edited)).toBe(false);
    const { digest: _d, ...unsigned } = evidence;
    const none = await checkDigest(unsigned);
    expect(none.recorded).toBeUndefined();
    expect(none.matches).toBe(false);
  });
});

describe("web viewer: links", () => {
  const base = "https://viewer.example.com/?url=x";
  const ok = (raw: string) => "url" in checkLink(raw, base);

  it("opens https files and the site's own samples", () => {
    expect(ok("https://raw.githubusercontent.com/o/r/main/preflight.json")).toBe(true);
    expect(ok("https://gist.githubusercontent.com/u/1/raw/evidence.json")).toBe(true);
    expect(ok("samples/report.json")).toBe(true);
  });

  it("refuses other schemes, credentials and private networks", () => {
    for (const raw of [
      "http://example.com/r.json",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pw@example.com/r.json",
      "https://localhost/r.json",
      "https://127.0.0.1/r.json",
      "https://2130706433/r.json",
      "https://10.0.0.5/r.json",
      "https://192.168.1.2/r.json",
      "https://172.20.0.1/r.json",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/r.json",
      "https://[fd00::1]/r.json",
      "https://intranet/r.json",
      "https://build.corp/r.json",
      "https://",
    ]) {
      expect(ok(raw), raw).toBe(false);
    }
  });

  it("tells private hosts from public ones", () => {
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("printer.local")).toBe(true);
  });
});
