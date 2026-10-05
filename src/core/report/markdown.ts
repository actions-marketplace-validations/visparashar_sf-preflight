// SPDX-License-Identifier: Apache-2.0
import { GENERIC_ORG_LABEL } from "../org/enrich.js";
import type { AnalysisResult, CascadeNode, Severity } from "../types.js";

const SEVERITY_BADGE: Record<Severity, string> = {
  high: "🔴 high",
  medium: "🟠 medium",
  low: "🟡 low",
  info: "⚪ info",
};
const RISK_BADGE = { high: "🔴 HIGH", medium: "🟠 MEDIUM", low: "🟢 LOW" } as const;

const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort();
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function cascadeLines(node: CascadeNode, prefix: string, isLast: boolean, isRoot: boolean, out: string[]): void {
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const via = node.via && node.via.kind !== "Change" ? `${viaLabel(node.via.kind)} ${node.via.name} → ` : "";
  const flags = `${node.cycle ? "  ⟲ cycle" : ""}${node.truncated ? "  … (depth limit)" : ""}`;
  const rootNote = isRoot && node.via ? `   [changed: ${node.via.name}]` : "";
  out.push(`${prefix}${connector}${isRoot ? "" : via}${node.object} (${node.event})${flags}${rootNote}`);
  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  node.children.forEach((c, i) => {
    cascadeLines(c, childPrefix, i === node.children.length - 1, false, out);
  });
}

function viaLabel(kind: string): string {
  switch (kind) {
    case "Flow":
      return "flow";
    case "ApexTrigger":
      return "trigger";
    case "ApexClass":
      return "class";
    case "RollUpSummary":
      return "roll-up";
    default:
      return kind;
  }
}

export interface MarkdownOptions {
  /** Max findings rows before collapsing the rest (default 25). */
  maxFindings?: number;
}

/** GitHub-flavoured Markdown, suitable for a PR comment. */
export function toMarkdown(result: AnalysisResult, opts: MarkdownOptions = {}): string {
  const s = result.summary;
  const out: string[] = [];
  const maxFindings = opts.maxFindings ?? 25;

  out.push(`## Preflight: ${RISK_BADGE[s.risk]} risk`);
  out.push("");
  out.push(
    `**${s.changedComponents}** changed component(s) → **${s.impactedObjects}** impacted object(s) · ` +
      `**${s.automationsInvolved}** automation(s) involved · **${s.cycles}** cycle(s) · ` +
      `findings: ${s.findingsBySeverity.high} high, ${s.findingsBySeverity.medium} medium, ${s.findingsBySeverity.low} low`,
  );
  if (result.base) out.push("", `_Compared \`${result.base}\` → \`${result.head ?? "working tree"}\`_`);
  const p = result.provenance;
  if (p?.aiAssistedCommits) {
    out.push(
      "",
      `> 🤖 **${p.aiAssistedCommits} of ${p.commits} commit(s) are AI-assisted** (${p.tools.join(", ")}). ` +
        "The analysis is the same either way — but AI-generated changes deserve a deliberate look at the findings below.",
    );
  }
  out.push("");

  // Changed components
  out.push("### Changed components", "");
  if (!result.changes.length) {
    out.push("_No Salesforce metadata changes detected._", "");
  } else {
    out.push("| Change | Type | Component |", "|---|---|---|");
    for (const c of result.changes)
      out.push(`| ${c.changeType} | ${c.component.type} | \`${esc(c.component.name)}\` |`);
    out.push("");
  }

  // Findings
  out.push("### Findings", "");
  if (!result.findings.length) {
    out.push("_No findings._", "");
  } else {
    out.push("| Severity | Finding | Details |", "|---|---|---|");
    for (const f of result.findings.slice(0, maxFindings)) {
      out.push(`| ${SEVERITY_BADGE[f.severity]} | ${esc(f.title)} | ${esc(f.detail)} |`);
    }
    if (result.findings.length > maxFindings)
      out.push("", `_…and ${result.findings.length - maxFindings} more in the JSON report._`);
    out.push("");
  }

  // Org context
  const org = result.org;
  if (org) {
    out.push(org.org === GENERIC_ORG_LABEL ? "### Org context" : `### Org context: \`${org.org}\``, "");
    const objects = uniqueSorted([
      ...result.impactedObjects,
      ...Object.keys(org.recordCounts),
      ...org.orgOnlyAutomation.map((a) => a.object),
    ]);
    if (objects.length) {
      out.push("| Object | Records | Automation only in the org (for this change) |", "|---|---:|---|");
      for (const o of objects) {
        const count = org.recordCounts[o];
        const extra = org.orgOnlyAutomation
          .filter((a) => a.object === o)
          .map(
            (a) =>
              `${a.kind === "ApexTrigger" ? "trigger" : a.kind === "Flow" ? "flow" : "VR"} \`${esc(a.namespace ? `${a.namespace}__${a.name}` : a.name)}\``,
          )
          .join(", ");
        out.push(`| ${o} | ${count === undefined ? "n/a" : count.toLocaleString("en-US")} | ${extra || "—"} |`);
      }
      out.push("");
      if (objects.some((o) => org.recordCounts[o] === undefined)) {
        out.push("<sub>n/a: Salesforce's record-count API returned no count for this object.</sub>", "");
      }
    }
    for (const a of org.assignments) {
      out.push(
        `- ${a.kind === "Profile" ? "Profile" : "Permission set"} \`${esc(a.name)}\` is assigned to **${a.activeUsers.toLocaleString("en-US")}** active user(s).`,
      );
    }
    if (org.packages.length)
      out.push(`- ${org.packages.length} installed package(s): ${org.packages.map((p) => esc(p.name)).join(", ")}.`);
    if (org.assignments.length || org.packages.length) out.push("");
    if (org.errors.length) {
      out.push("<details><summary>Org queries that failed</summary>", "");
      for (const e of org.errors) out.push(`- ${esc(e)}`);
      out.push("", "</details>", "");
    }
  }

  // Cascade
  if (result.cascade.length) {
    out.push(
      "### Cascade",
      "",
      "What the change sets off, following automation writes from object to object:",
      "",
      "```",
    );
    for (const root of result.cascade) {
      cascadeLines(root, "", true, true, out);
    }
    out.push("```", "");
  }

  // Save procedures
  if (result.saveProcedures.length) {
    out.push("<details><summary><strong>Order of execution for impacted objects</strong></summary>", "");
    for (const p of result.saveProcedures) {
      out.push(
        `#### ${p.object} — ${p.event}`,
        "",
        "| # | Phase | Automation | Writes to | Notes |",
        "|---|---|---|---|---|",
      );
      for (const step of p.steps) {
        const writes = step.writes.length
          ? step.writes.map((w) => `${w.object} (${w.op}${w.selfUpdate ? ", self" : ""})`).join(", ")
          : "—";
        out.push(
          `| ${step.order} | ${step.phaseLabel} | \`${esc(step.automation.name)}\` | ${esc(writes)} | ${esc(step.notes.join("; ")) || ""} |`,
        );
      }
      out.push("");
    }
    out.push("</details>", "");
  }

  // References
  if (result.references.length) {
    out.push("<details><summary><strong>References to changed fields</strong></summary>", "");
    out.push("| Field | Referenced by |", "|---|---|");
    for (const r of result.references) out.push(`| \`${esc(r.to)}\` | ${r.from.kind} \`${esc(r.from.name)}\` |`);
    out.push("", "</details>", "");
  }

  // Suggested tests
  if (result.suggestedTests.length) {
    out.push("### Suggested tests", "");
    for (const t of result.suggestedTests) out.push(`- [ ] **${t.kind}** — ${t.description}`);
    out.push("");
  }

  if (result.warnings.length) {
    out.push("<details><summary>Analyzer warnings</summary>", "");
    for (const w of result.warnings) out.push(`- ${w}`);
    out.push("", "</details>", "");
  }

  out.push(
    `<sub>Generated by [sf-preflight](https://github.com/visparashar/sf-preflight) · static analysis of your SFDX source${
      result.org ? " plus read-only org context" : ""
    }.</sub>`,
  );
  return out.join("\n");
}
