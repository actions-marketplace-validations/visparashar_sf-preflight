// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { RULES, ruleInfo } from "../rules.js";
import type { AnalysisResult, Finding, Severity } from "../types.js";

const REPO_URL = "https://github.com/visparashar/sf-preflight";
const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};
const SECURITY_SEVERITY: Record<Severity, string> = { high: "8.0", medium: "5.0", low: "3.0", info: "1.0" };

export interface SarifOptions {
  toolVersion?: string;
}

/**
 * SARIF 2.1.0 for GitHub code scanning and other SARIF viewers. File paths are made relative
 * to the git root (via `projectPathInRepo`) so annotations land on the right files.
 */
export function toSarif(result: AnalysisResult, opts: SarifOptions = {}): object {
  const prefix = result.projectPathInRepo ? `${result.projectPathInRepo.replace(/\/$/, "")}/` : "";
  const fallbackFile = "sfdx-project.json";

  const usedRules = new Set(result.findings.map((f) => f.rule));
  const rules = RULES.filter((r) => usedRules.has(r.id)).map((r) => ({
    id: r.id,
    name: r.name,
    shortDescription: { text: r.summary },
    fullDescription: { text: `${r.summary} ${r.help}` },
    help: { text: r.help, markdown: `${r.help}\n\n[Rule documentation](${REPO_URL}/blob/main/docs/RULES.md#${r.id})` },
    helpUri: `${REPO_URL}/blob/main/docs/RULES.md#${r.id}`,
    defaultConfiguration: { level: LEVEL[r.defaultSeverity] },
    properties: {
      tags: ["salesforce", ...(r.security ? ["security"] : ["reliability"])],
      ...(r.security ? { "security-severity": SECURITY_SEVERITY[r.defaultSeverity] } : {}),
    },
  }));
  // Findings from rules missing in the catalog still need a rule entry.
  for (const id of usedRules) {
    if (!ruleInfo(id)) rules.push({ id, name: id, shortDescription: { text: id } } as (typeof rules)[number]);
  }

  const results = result.findings.map((f: Finding) => {
    const files = f.files.length ? f.files : [fallbackFile];
    return {
      ruleId: f.rule,
      level: LEVEL[f.severity],
      message: { text: `${f.title}. ${f.detail}` },
      locations: files.slice(0, 1).map((file, i) => ({
        physicalLocation: {
          artifactLocation: { uri: `${prefix}${file}`, uriBaseId: "%SRCROOT%" },
          region: { startLine: i === 0 && f.line ? f.line : 1 },
        },
      })),
      relatedLocations: files.slice(1).map((file, i) => ({
        id: i + 1,
        physicalLocation: { artifactLocation: { uri: `${prefix}${file}`, uriBaseId: "%SRCROOT%" } },
      })),
      partialFingerprints: {
        "preflightFinding/v1": createHash("sha256").update(`${f.rule}|${f.title}`).digest("hex").slice(0, 32),
      },
      properties: { severity: f.severity, ...(f.object ? { object: f.object } : {}) },
    };
  });

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "sf-preflight",
            ...(opts.toolVersion ? { version: opts.toolVersion, semanticVersion: opts.toolVersion } : {}),
            informationUri: REPO_URL,
            rules,
          },
        },
        automationDetails: { id: "sf-preflight/" },
        results,
        properties: {
          risk: result.summary.risk,
          impactedObjects: result.impactedObjects,
          ...(result.provenance
            ? { aiAssistedCommits: result.provenance.aiAssistedCommits, aiTools: result.provenance.tools }
            : {}),
        },
      },
    ],
  };
}
