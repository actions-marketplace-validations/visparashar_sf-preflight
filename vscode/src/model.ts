// SPDX-License-Identifier: Apache-2.0
/**
 * What the extension shows, computed from an analysis result without the VS Code API, so it can
 * be tested on its own: problems per file, the blast-radius tree and the status bar text.
 */
import path from "node:path";
import type { AnalysisResult, Finding, SaveEvent, Severity } from "../../src/core/types.js";

export const RULES_URL = "https://github.com/visparashar/sf-preflight/blob/main/docs/RULES.md";
const ORDER: Severity[] = ["high", "medium", "low", "info"];
const rank = (s: Severity) => ORDER.indexOf(s);

export interface Problem {
  /** Absolute path of the file. */
  file: string;
  /** 0-based line. */
  line: number;
  severity: Severity;
  message: string;
  rule: string;
  /** Other files involved, for related information. */
  related: string[];
}

/**
 * Findings as problems on their files: the primary file at the finding's line (or the top), and
 * each other file involved at its top. Findings below `minSeverity` are left out.
 */
export function problemsOf(result: AnalysisResult, minSeverity: Severity = "low"): Problem[] {
  const abs = (f: string) => path.resolve(result.projectDir, f);
  const out: Problem[] = [];
  for (const f of result.findings) {
    if (rank(f.severity) > rank(minSeverity) || !f.files.length) continue;
    const files = [...new Set(f.files)];
    for (const [i, file] of files.entries()) {
      out.push({
        file: abs(file),
        line: i === 0 && f.line ? Math.max(0, f.line - 1) : 0,
        severity: f.severity,
        message: messageOf(f),
        rule: f.rule,
        related: files.filter((x) => x !== file).map(abs),
      });
    }
  }
  return out;
}

const messageOf = (f: Finding) => `${f.title}\n${f.detail}`.trim();

export interface TreeNode {
  label: string;
  description?: string;
  tooltip?: string;
  /** Codicon id, e.g. "error". */
  icon?: string;
  /** Absolute file to open, and 0-based line. */
  file?: string;
  line?: number;
  children?: TreeNode[];
  /** Expanded by default. */
  expanded?: boolean;
  /** Command run on click, when there's no file to open. */
  command?: string;
}

const SEVERITY_ICON: Record<Severity, string> = {
  high: "error",
  medium: "warning",
  low: "info",
  info: "circle-outline",
};
const CHANGE_ICON: Record<string, string> = {
  added: "diff-added",
  modified: "diff-modified",
  deleted: "diff-removed",
  renamed: "diff-renamed",
};
const AUTOMATION_ICON: Record<string, string> = {
  Flow: "type-hierarchy",
  ApexTrigger: "zap",
  ApexClass: "symbol-class",
  ValidationRule: "shield",
  RollUpSummary: "sum",
  Change: "edit",
};
const EVENT_LABEL: Record<SaveEvent, string> = {
  insert: "insert",
  update: "update",
  delete: "delete",
  undelete: "undelete",
};

/** The blast-radius tree for one project's analysis. */
export function treeOf(result: AnalysisResult, label?: string): TreeNode[] {
  const abs = (f: string) => path.resolve(result.projectDir, f);
  const s = result.summary;
  const counts = ORDER.filter((x) => s.findingsBySeverity[x])
    .map((x) => `${s.findingsBySeverity[x]} ${x}`)
    .join(", ");
  const nodes: TreeNode[] = [];
  nodes.push({
    label: `Risk: ${s.risk}`,
    description: [label, counts || "no findings"].filter(Boolean).join(" · "),
    icon: s.risk === "high" ? "error" : s.risk === "medium" ? "warning" : "pass",
    tooltip: `${s.changedComponents} changed component(s), ${s.impactedObjects} impacted object(s), ${s.automationsInvolved} automation(s) involved${result.base ? `, compared with ${result.base}` : ""}. Click for the graph.`,
    ...(result.changes.length ? { command: "sfPreflight.showGraph" } : {}),
  });

  if (!result.changes.length) {
    nodes.push({ label: "No Salesforce metadata changed", icon: "check" });
    return nodes;
  }

  const findings = [...result.findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  if (findings.length) {
    nodes.push({
      label: "Findings",
      description: String(findings.length),
      icon: "checklist",
      expanded: true,
      children: findings.map((f) => ({
        label: f.title,
        description: f.rule,
        tooltip: `${f.severity.toUpperCase()}: ${f.detail}`,
        icon: SEVERITY_ICON[f.severity],
        ...(f.files[0] ? { file: abs(f.files[0]), line: f.line ? f.line - 1 : 0 } : {}),
      })),
    });
  }

  nodes.push({
    label: "Changed components",
    description: String(result.changes.length),
    icon: "git-commit",
    children: result.changes.map((c) => ({
      label: c.component.name,
      description: `${c.component.type} · ${c.changeType}`,
      icon: CHANGE_ICON[c.changeType] ?? "file",
      ...(c.changeType === "deleted" ? {} : { file: abs(c.component.file), line: 0 }),
    })),
  });

  if (result.saveProcedures.length) {
    nodes.push({
      label: "What runs",
      description: `${result.saveProcedures.length} save(s)`,
      tooltip: "Each impacted object and event, with its automation in order of execution",
      icon: "run-all",
      expanded: true,
      children: result.saveProcedures.map((sp) => ({
        label: `${sp.object} ${EVENT_LABEL[sp.event]}`,
        description: `${sp.steps.length} step(s)`,
        icon: "database",
        children: sp.steps.map((st) => ({
          label: `${st.order}. ${st.automation.name}`,
          description: [st.phaseLabel, st.writes.length ? `writes ${st.writes.map((w) => w.object).join(", ")}` : ""]
            .filter(Boolean)
            .join(" · "),
          tooltip: st.notes.join("\n") || undefined,
          icon: AUTOMATION_ICON[st.automation.kind] ?? "symbol-event",
          ...(st.automation.file ? { file: abs(st.automation.file), line: 0 } : {}),
        })),
      })),
    });
  }

  if (result.cycles.length) {
    nodes.push({
      label: "Cycles",
      description: String(result.cycles.length),
      icon: "sync",
      children: result.cycles.map((c) => ({ label: c.join(" → "), icon: "warning" })),
    });
  }

  if (result.agents.length) {
    nodes.push({
      label: "Agent actions affected",
      description: String(result.agents.length),
      icon: "hubot",
      children: result.agents.map((a) => ({
        label: a.actionLabel ?? a.action,
        description: [a.agentLabel ?? a.agent, a.topic].filter(Boolean).join(" · "),
        tooltip: a.reasons.join("\n"),
        icon: "hubot",
      })),
    });
  }
  return nodes;
}

/** Status bar text for the analyses of all projects in the workspace. */
export function statusOf(results: AnalysisResult[]): {
  text: string;
  tooltip: string;
  level: "error" | "warning" | "ok";
} {
  if (!results.length) return { text: "$(shield) Preflight", tooltip: "sf-preflight", level: "ok" };
  const count = (s: Severity) => results.reduce((n, r) => n + (r.summary.findingsBySeverity[s] ?? 0), 0);
  const high = count("high");
  const medium = count("medium");
  const changed = results.reduce((n, r) => n + r.changes.length, 0);
  const level = high ? "error" : medium ? "warning" : "ok";
  const icon = level === "error" ? "$(error)" : level === "warning" ? "$(warning)" : "$(pass)";
  const text = !changed ? "$(shield) Preflight: no changes" : `${icon} Preflight: ${high} high, ${medium} medium`;
  const tooltip = `sf-preflight: ${changed} changed component(s). Click to open the blast radius.`;
  return { text, tooltip, level };
}

/** Is this file Salesforce source metadata worth re-analyzing on save? */
export function isMetadataFile(file: string): boolean {
  return /\.(cls|trigger|agent)$|-meta\.xml$|\.genAiPlannerBundle$|sfdx-project\.json$|\.preflight\.json$/.test(file);
}
