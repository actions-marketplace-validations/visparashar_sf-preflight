// SPDX-License-Identifier: Apache-2.0
import { orgRef } from "../org/enrich.js";
import { describeSignature } from "./classify.js";
import type { FailingComponent } from "./collect.js";
import type { RollbackPlan } from "./rollback.js";
import { describeComponent, type IncidentReport, type Suspect } from "./trace.js";

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
const where = (c: FailingComponent) => {
  const base = describeComponent(c.kind, c.name);
  if (!c.element) return base;
  return c.kind === "AgentAction" ? `${base} in topic \`${c.element}\`` : `${base} at \`${c.element}\``;
};
const changeLabel = (s: Suspect) => `\`${s.change.shortSha}\`${s.change.pr ? ` #${s.change.pr}` : ""}`;

/** The components a partial rollback would cover, as `--component` arguments. */
function rollbackCommand(s: Suspect): string {
  return `preflight rollback ${s.change.shortSha} --component ${s.components.map((c) => c.name).join(" ")}`;
}

export function incidentsToMarkdown(r: IncidentReport): string {
  const out: string[] = [];
  out.push(`### Production errors${r.org ? ` in ${orgRef(r.org)}` : ""} since ${r.since.slice(0, 10)}`, "");
  const read = r.sources.filter((s) => s.status === "ok").map((s) => `${s.label} (${s.events})`);
  const missing = r.sources.filter((s) => s.status !== "ok");
  if (read.length) out.push(`Read: ${read.join(" · ")}.`);
  for (const s of missing) {
    out.push(
      `${s.status === "unavailable" ? "Not available" : "⚠️ Couldn't read"}: ${s.label}${s.note ? ` (${s.note})` : ""}.`,
    );
  }
  out.push("");
  const traced = r.incidents.filter((i) => i.suspects.length).length;
  out.push(
    r.incidents.length
      ? `**${r.incidents.length} problem${r.incidents.length === 1 ? "" : "s"}, ${traced} traced to recent changes.** Checked ${r.history.changes} change${r.history.changes === 1 ? "" : "s"} on \`${r.history.ref}\`${r.history.from ? ` since ${r.history.from.slice(0, 10)}` : ""}.`
      : "**No errors found** in the sources read.",
  );
  if (r.history.shallow) {
    out.push("", "⚠️ The repository is a shallow clone, so older changes may be missing (fetch the full history).");
  }
  if (!r.incidents.length) return out.join("\n");

  out.push(
    "",
    "| # | Error | Where | Count | First seen | Last seen | Likely cause |",
    "|---|---|---|---|---|---|---|",
  );
  r.incidents.forEach((i, n) => {
    const top = i.suspects[0];
    out.push(
      `| ${n + 1} | ${cell(describeSignature(i.signature))} | ${cell(where(i.component))} | ${i.count} | ${when(i.firstSeen)} | ${when(i.lastSeen)} | ${top ? `${changeLabel(top)} (${top.confidence})` : "—"} |`,
    );
  });

  r.incidents.forEach((i, n) => {
    out.push("", `#### ${n + 1}. ${describeSignature(i.signature)} in ${where(i.component)}`, "");
    if (i.via.length) out.push(`Also involved: ${i.via.map(where).join(", ")}.`, "");
    if (!i.suspects.length) {
      out.push(
        "No recent change explains it. It may come from data, from configuration changed directly in the org, or from a change older than the history checked.",
      );
      return;
    }
    for (const s of i.suspects) {
      out.push(
        `- **${changeLabel(s)}** ${s.change.subject} (${s.change.date.slice(0, 10)}) · ${s.confidence} confidence`,
        ...s.reasons.map((x) => `  - ${x}`),
        `  - Partial rollback: \`${rollbackCommand(s)}\``,
      );
    }
  });
  out.push(
    "",
    "Error messages are reduced to their kind, exception type, status code and the metadata they name: no record data, record IDs or user names. Times are UTC.",
  );
  return out.join("\n");
}

const ACTION_LABEL = { restore: "Restore", deactivate: "Deactivate", keep: "Keep", remove: "Remove" } as const;

export function rollbackToMarkdown(p: RollbackPlan): string {
  const c = p.change;
  const out = [
    `### Partial rollback of \`${c.shortSha}\`${c.pr ? ` (#${c.pr})` : ""}: ${c.subject}`,
    "",
    "| Component | The change | Rollback |",
    "|---|---|---|",
  ];
  for (const s of p.steps) {
    const how = `**${ACTION_LABEL[s.action]}.** ${s.how}${s.because ? ` Needed because ${s.because}.` : ""}`;
    out.push(
      `| ${cell(describeComponent(s.component.type, s.component.name))} | ${s.component.changeType} | ${cell(how)} |`,
    );
  }
  if (p.warnings.length) out.push("", ...p.warnings.map((w) => `⚠️ ${w}`));
  if (p.commands.length) {
    out.push(
      "",
      "Roll back through a pull request, so the rollback gets the same review, quality gate and evidence as any change:",
      "",
      "```bash",
      ...p.commands,
      "```",
    );
    if (p.apex) out.push("", "The rollback includes Apex, so a production deployment runs tests.");
  } else {
    out.push("", "Nothing to restore or deactivate: follow the steps above.");
  }
  return out.join("\n");
}
