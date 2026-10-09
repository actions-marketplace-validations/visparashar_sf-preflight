// SPDX-License-Identifier: Apache-2.0
/**
 * What a JSON file is: an analysis report (`preflight analyze --format json`), an evidence pack
 * (`preflight evidence`, or the GitHub Action's artifact), or something the viewer can't show, with
 * a reason that says what to open instead. Kept free of browser APIs so it is tested with the library.
 */
import { EVIDENCE_PREDICATE_TYPE, type EvidencePack } from "../../../src/core/evidence.js";
import type { AnalysisResult, Severity } from "../../../src/core/types.js";

export type Detected =
  | { kind: "report"; report: AnalysisResult; newer: boolean }
  | { kind: "evidence"; evidence: EvidencePack; newer: boolean }
  | { kind: "unsupported"; reason: string };

const SEVERITIES: Severity[] = ["high", "medium", "low", "info"];
const RISKS = ["high", "medium", "low"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arrayOr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function severityCounts(v: unknown): Record<Severity, number> {
  const src = isObject(v) ? v : {};
  return Object.fromEntries(
    SEVERITIES.map((s) => [s, typeof src[s] === "number" && Number.isFinite(src[s]) ? src[s] : 0]),
  ) as Record<Severity, number>;
}

/**
 * Fills the lists an older or partial report may leave out, so the views can rely on them. Returns
 * undefined when the core of a report (its summary and findings) is missing.
 */
export function normalizeReport(json: Record<string, unknown>): AnalysisResult | undefined {
  const summary = json.summary;
  if (!isObject(summary) || !RISKS.includes(summary.risk as string) || !Array.isArray(json.findings)) return undefined;
  const findings = arrayOr<Record<string, unknown>>(json.findings).filter(
    (f) => isObject(f) && SEVERITIES.includes(f.severity as Severity) && typeof f.title === "string",
  );
  return {
    ...(json as unknown as AnalysisResult),
    changes: arrayOr(json.changes),
    ignoredFiles: arrayOr(json.ignoredFiles),
    references: arrayOr(json.references),
    impactedObjects: arrayOr(json.impactedObjects),
    saveProcedures: arrayOr(json.saveProcedures),
    cascade: arrayOr(json.cascade),
    cycles: arrayOr(json.cycles),
    findings: findings.map((f) => ({ ...f, files: arrayOr(f.files) })) as unknown as AnalysisResult["findings"],
    suggestedTests: arrayOr(json.suggestedTests),
    agents: arrayOr(json.agents),
    warnings: arrayOr(json.warnings),
    summary: {
      ...(summary as unknown as AnalysisResult["summary"]),
      findingsBySeverity: severityCounts(summary.findingsBySeverity),
    },
  };
}

function normalizeEvidence(json: Record<string, unknown>): EvidencePack | undefined {
  const { change, analysis, gate, digest } = json;
  if (!isObject(change) || !isObject(analysis) || !isObject(gate) || !isObject(digest)) return undefined;
  if (!Array.isArray(change.components) || !Array.isArray(gate.checks)) return undefined;
  return json as unknown as EvidencePack;
}

export function detect(json: unknown): Detected {
  if (!isObject(json)) {
    return { kind: "unsupported", reason: "The file holds JSON, but not a report or an evidence pack." };
  }
  if (json.predicateType === EVIDENCE_PREDICATE_TYPE || "evidenceVersion" in json) {
    const evidence = normalizeEvidence(json);
    if (!evidence) return { kind: "unsupported", reason: "This evidence pack is missing required sections." };
    return { kind: "evidence", evidence, newer: json.evidenceVersion !== 1 };
  }
  if ("schemaVersion" in json && "summary" in json) {
    const report = normalizeReport(json);
    if (!report) return { kind: "unsupported", reason: "This report is missing its summary or findings." };
    return { kind: "report", report, newer: json.schemaVersion !== 1 };
  }
  if (json.version === "2.1.0" && Array.isArray(json.runs)) {
    return {
      kind: "unsupported",
      reason: "This is a SARIF file, made for code scanning. Open the JSON report instead (--format json).",
    };
  }
  if ("orgKind" in json && Array.isArray(json.componentErrors)) {
    return {
      kind: "unsupported",
      reason: "This is a test run result (preflight tests --validate). The viewer shows it inside an evidence pack.",
    };
  }
  if ("orgKind" in json && Array.isArray(json.runs)) {
    return {
      kind: "unsupported",
      reason: "This is a Testing Center result (preflight agent-tests). The viewer shows it inside an evidence pack.",
    };
  }
  return { kind: "unsupported", reason: "This isn't an sf-preflight report or evidence pack." };
}
