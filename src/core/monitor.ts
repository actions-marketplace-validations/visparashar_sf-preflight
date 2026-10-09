// SPDX-License-Identifier: Apache-2.0
import { type Alert, plain } from "./notify.js";
import { orgLabel } from "./org/enrich.js";
import { assertSafeOrg, createSfRunner, type QueryRecord, query, type SfRunner } from "./org/sf.js";
import type { OrgModel } from "./types.js";
import { redactEmails } from "./util.js";

/**
 * Monitor: reads the Setup Audit Trail of an org (read-only, one SOQL query), picks out the
 * changes that are risky to make in a live org, and reports them. Meant to run on a schedule.
 *
 * Privacy: the audit trail names the person who made each change. That name is read only when
 * `ignoreUsers` is used (to skip a deployment user) and is never copied into a report or alert.
 * Email addresses in the text of an entry are removed.
 */

export interface AuditEntry {
  action: string;
  section: string;
  display: string;
  createdDate: string;
  /** Only filled when the query asked for it (see `ignoreUsers`). Never reported. */
  user?: string;
}

export type MonitorSeverity = "high" | "medium";

export interface MonitorFinding {
  severity: MonitorSeverity;
  rule: string;
  label: string;
  /** The audit trail's own wording, cleaned. Empty for rules where it could name a person. */
  detail: string;
  when: string;
  /** Present when a project was given: does a component of that name exist in the repository? */
  inRepository?: boolean;
}

export interface MonitorReport {
  org: string;
  since: string;
  until: string;
  /** Audit trail entries read. */
  scanned: number;
  /** Entries left out because of `ignoreUsers`. */
  skipped: number;
  risk: "high" | "medium" | "low";
  findings: MonitorFinding[];
  /** The newest entry's time, for `--state`. */
  newest?: string;
  /** Set when the query hit its row limit, so older entries in the window may be missing. */
  truncated?: boolean;
}

interface Rule {
  id: string;
  severity: MonitorSeverity;
  label: string;
  test: (text: string) => boolean;
  /** False when the entry could name a person (assignments), so the wording is left out. */
  showDetail: boolean;
}

const has = (re: RegExp) => (t: string) => re.test(t);

/** Ordered: the first rule that matches decides. Matching is on section, action and display text. */
export const RULES: Rule[] = [
  {
    id: "validation-deactivated",
    severity: "high",
    label: "Validation rule deactivated",
    test: (t) => /validation/.test(t) && /inactiv|deactiv/.test(t),
    showDetail: true,
  },
  {
    id: "flow-deactivated",
    severity: "high",
    label: "Flow deactivated",
    test: (t) => /\bflow\b|process builder/.test(t) && /deactiv|inactiv|obsolete/.test(t),
    showDetail: true,
  },
  {
    id: "broad-permission",
    severity: "high",
    label: "Broad permission granted",
    test: has(
      /modify all data|view all data|author apex|customize application|manage users|modify metadata|manage profiles/,
    ),
    showDetail: true,
  },
  {
    id: "apex-changed",
    severity: "high",
    label: "Apex changed in the org",
    test: (t) => /apex (class|trigger)/.test(t) && /creat|chang|delet|updat|sav|deploy/.test(t),
    showDetail: true,
  },
  {
    id: "sharing",
    severity: "high",
    label: "Sharing model changed",
    test: has(/organization-wide|org-wide|sharing (rule|setting)|default external access|default internal access/),
    showDetail: true,
  },
  {
    id: "security-config",
    severity: "medium",
    label: "Security setting changed",
    test: has(
      /remote site|named credential|external credential|connected app|certificate|trusted ip|login ip|session setting|password polic|single sign|sso|cors|csp trusted/,
    ),
    showDetail: true,
  },
  {
    id: "field-deleted",
    severity: "medium",
    label: "Field or object deleted",
    test: (t) => /delet/.test(t) && /custom (field|object)|\bfield\b|\bobject\b/.test(t),
    showDetail: true,
  },
  {
    id: "flow-activated",
    severity: "medium",
    label: "Flow activated",
    test: (t) => /\bflow\b|process builder/.test(t) && /activat/.test(t),
    showDetail: true,
  },
  {
    id: "validation-changed",
    severity: "medium",
    label: "Validation rule changed",
    test: (t) => /validation/.test(t) && /chang|creat|delet|updat/.test(t),
    showDetail: true,
  },
  {
    id: "permission-assigned",
    severity: "medium",
    label: "Permission set or profile assigned",
    test: (t) =>
      (/permission set/.test(t) && /assign/.test(t)) || /changed profile for user|changed .*profile (to|from)/.test(t),
    showDetail: false,
  },
  {
    id: "access-changed",
    severity: "medium",
    label: "Profile or permission set changed",
    test: (t) => /(profile|permission set)/.test(t) && /chang|creat|delet|updat/.test(t),
    showDetail: true,
  },
];

const RANK = { low: 0, medium: 1, high: 2 } as const;

/** Pure: sort audit entries into findings. Entries that match no rule are ignored. */
export function classifyAudit(
  entries: AuditEntry[],
  opts: { model?: OrgModel; ignoreUsers?: string[] } = {},
): { findings: MonitorFinding[]; skipped: number } {
  const ignore = new Set((opts.ignoreUsers ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean));
  const names = opts.model ? repoNames(opts.model) : undefined;
  const findings: MonitorFinding[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (e.user && ignore.has(e.user.trim().toLowerCase())) {
      skipped++;
      continue;
    }
    const text = `${e.section} ${e.action} ${e.display}`.toLowerCase();
    const rule = RULES.find((r) => r.test(text));
    if (!rule) continue;
    const f: MonitorFinding = {
      severity: rule.severity,
      rule: rule.id,
      label: rule.label,
      detail: rule.showDetail ? plain(redactEmails(e.display), 200) : "",
      when: e.createdDate,
    };
    if (names) f.inRepository = names.some((n) => text.includes(n));
    findings.push(f);
  }
  findings.sort(
    (a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) || b.when.localeCompare(a.when),
  );
  return { findings, skipped };
}

/** Lower-cased component names long enough to match without false hits. */
function repoNames(model: OrgModel): string[] {
  const out = new Set<string>();
  for (const c of model.components.values()) {
    const n = c.name.toLowerCase();
    if (n.length >= 5) out.add(n);
    const last = n.split(".").pop();
    if (last && last.length >= 5) out.add(last);
  }
  return [...out];
}

const MAX_ROWS = 2000;
const soqlTime = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

/** Read the audit trail. `after` is exclusive (used with a saved high-water mark). */
export function readAuditTrail(
  run: SfRunner,
  org: string,
  since: Date,
  opts: { withUser?: boolean; exclusive?: boolean } = {},
): AuditEntry[] {
  const cols = `Action, Section, Display, CreatedDate${opts.withUser ? ", CreatedBy.Name" : ""}`;
  const soql = `SELECT ${cols} FROM SetupAuditTrail WHERE CreatedDate ${opts.exclusive ? ">" : ">="} ${soqlTime(since)} ORDER BY CreatedDate DESC LIMIT ${MAX_ROWS}`;
  return query(run, org, soql).map((r: QueryRecord) => ({
    action: String(r.Action ?? ""),
    section: String(r.Section ?? ""),
    display: String(r.Display ?? ""),
    createdDate: String(r.CreatedDate ?? ""),
    user: opts.withUser ? String((r.CreatedBy as { Name?: unknown } | null)?.Name ?? "") : undefined,
  }));
}

export interface MonitorOptions {
  org: string;
  since: Date;
  /** Treat `since` as exclusive (it is a saved high-water mark). */
  exclusive?: boolean;
  model?: OrgModel;
  ignoreUsers?: string[];
  run?: SfRunner;
  now?: Date;
}

export function runMonitor(opts: MonitorOptions): MonitorReport {
  const org = assertSafeOrg(opts.org);
  const run = opts.run ?? createSfRunner();
  const entries = readAuditTrail(run, org, opts.since, {
    withUser: !!opts.ignoreUsers?.length,
    exclusive: opts.exclusive,
  });
  const { findings, skipped } = classifyAudit(entries, { model: opts.model, ignoreUsers: opts.ignoreUsers });
  const risk = findings.some((f) => f.severity === "high") ? "high" : findings.length ? "medium" : "low";
  return {
    org: orgLabel(org),
    since: opts.since.toISOString(),
    until: (opts.now ?? new Date()).toISOString(),
    scanned: entries.length,
    skipped,
    risk,
    findings,
    newest: entries
      .map((e) => e.createdDate)
      .sort()
      .pop(),
    truncated: entries.length >= MAX_ROWS || undefined,
  };
}

/** Whether the report reaches the alert threshold. */
export function monitorShouldNotify(report: Pick<MonitorReport, "risk">, level: "medium" | "high"): boolean {
  return RANK[report.risk] >= RANK[level];
}

export function alertFromMonitor(
  report: MonitorReport,
  opts: { link?: { label: string; url: string }; source?: string } = {},
): Alert {
  const high = report.findings.filter((f) => f.severity === "high").length;
  const medium = report.findings.length - high;
  const counts = [
    high ? `${high} high` : "",
    medium ? `${medium} medium` : "",
    `${report.scanned} audit entries read`,
  ].filter(Boolean);
  const top = report.findings.slice(0, 5);
  return {
    risk: report.risk,
    title: plain(`Risky change${report.findings.length === 1 ? "" : "s"} in ${report.org}`, 100),
    summary: counts.join(" · "),
    items: top.map((f) => ({
      severity: f.severity,
      text: plain(
        `${f.label}${f.detail ? `: ${f.detail}` : ""}${f.inRepository === false ? " (no matching component in the repository)" : ""}`,
        240,
      ),
    })),
    components: [],
    more: Math.max(0, report.findings.length - top.length),
    link:
      opts.link && /^https:\/\//i.test(opts.link.url)
        ? { label: plain(opts.link.label, 60), url: opts.link.url }
        : undefined,
    source: opts.source ? plain(opts.source, 120) : `${plain(report.org, 60)} audit trail`,
  };
}

export function monitorToMarkdown(report: MonitorReport): string {
  const lines = [
    `# Production change monitor: ${plain(report.org, 80)}`,
    "",
    `${report.since} to ${report.until} · ${report.scanned} audit entries read · risk **${report.risk}**`,
    "",
  ];
  if (!report.findings.length) lines.push("No risky setup changes in this period.");
  else {
    lines.push("| Severity | Change | When (UTC) | In repository |", "|---|---|---|---|");
    for (const f of report.findings) {
      const cell = plain(`${f.label}${f.detail ? `: ${f.detail}` : ""}`, 240).replace(/\|/g, "\\|");
      const repo = f.inRepository === undefined ? "–" : f.inRepository ? "name found" : "**no match**";
      lines.push(`| ${f.severity} | ${cell} | ${plain(f.when, 30)} | ${repo} |`);
    }
  }
  if (report.skipped)
    lines.push("", `${report.skipped} entr${report.skipped === 1 ? "y" : "ies"} by ignored users left out.`);
  if (report.truncated)
    lines.push(
      "",
      "The audit trail query hit its row limit, so older entries in this period may be missing. Run it more often.",
    );
  lines.push(
    "",
    "_Matching is on the audit trail's wording and on component names, so treat it as a prompt to look, not proof. Who made a change is never shown._",
  );
  return lines.join("\n");
}
