// SPDX-License-Identifier: Apache-2.0
import { summarizeFindings } from "../analyze.js";
import type { AnalysisResult, Finding, OrgAutomation, OrgContext, OrgModel } from "../types.js";
import { key, uniq } from "../util.js";
import { assertSafeOrg, createSfRunner, field, query, SfError, type SfRunner, soqlList, soqlStringList } from "./sf.js";

/**
 * Optional, read-only enrichment from a Salesforce org (`--org`):
 *
 * - record counts for impacted objects (realistic bulk tests),
 * - active flows, triggers and validation rules on impacted objects that exist in the org but
 *   not in the project (the cascade can't see them),
 * - how many active users hold each changed permission set / profile,
 * - installed packages (to label managed automation).
 *
 * Only counts and metadata names are collected — never record data or user names — so the
 * context is safe to include in pull-request comments.
 */
export interface OrgEnrichOptions {
  org: string;
  runner?: SfRunner;
  /** Cap on objects queried (default 100). */
  maxObjects?: number;
}

const RECORD_TRIGGER_EVENTS: Record<string, string[]> = {
  Create: ["insert"],
  Update: ["update"],
  CreateAndUpdate: ["insert", "update"],
  Delete: ["delete"],
};
const FLOW_TIMING: Record<string, string> = {
  RecordBeforeSave: "before",
  RecordAfterSave: "after",
  RecordBeforeDelete: "before",
};
const TRIGGER_USAGE: [string, string][] = [
  ["UsageBeforeInsert", "before insert"],
  ["UsageAfterInsert", "after insert"],
  ["UsageBeforeUpdate", "before update"],
  ["UsageAfterUpdate", "after update"],
  ["UsageBeforeDelete", "before delete"],
  ["UsageAfterDelete", "after delete"],
  ["UsageAfterUndelete", "after undelete"],
];
/** Source file names of standard profiles → their names in the org. */
const STANDARD_PROFILES: Record<string, string> = {
  admin: "System Administrator",
  standard: "Standard User",
  readonly: "Read Only",
  solutionmanager: "Solution Manager",
  marketingprofile: "Marketing User",
  contractmanager: "Contract Manager",
  standardaul: "Standard Platform User",
};

const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{15,18}$/.test(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function collectOrgContext(model: OrgModel, result: AnalysisResult, opts: OrgEnrichOptions): OrgContext {
  const org = assertSafeOrg(opts.org);
  const run = opts.runner ?? createSfRunner();
  const ctx: OrgContext = {
    org,
    queriedAt: new Date().toISOString(),
    recordCounts: {},
    assignments: [],
    orgOnlyAutomation: [],
    packages: [],
    errors: [],
  };
  const attempt = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      ctx.errors.push(`${label}: ${(err as Error).message}`);
    }
  };

  // Fail fast when the org isn't reachable: the user explicitly asked for org context.
  try {
    run(["org", "display", "--target-org", org]);
  } catch (err) {
    throw new SfError(`Could not use org "${org}": ${(err as Error).message}`);
  }

  const objects = uniq([
    ...result.impactedObjects,
    ...result.changes.map((c) => c.component.object).filter((o): o is string => !!o),
  ])
    .filter((o) => /^[A-Za-z][A-Za-z0-9_]*$/.test(o))
    .slice(0, opts.maxObjects ?? 100);

  // Object ids/labels, to match automation that references custom objects by id.
  const objectByRef = new Map<string, string>();
  if (objects.length) {
    attempt("objects", () => {
      for (const o of objects) objectByRef.set(key(o), o);
      const rows = query(
        run,
        org,
        `SELECT QualifiedApiName, DurableId, Label FROM EntityDefinition WHERE QualifiedApiName IN (${soqlList(objects)})`,
      );
      for (const r of rows) {
        const name = str(r.QualifiedApiName);
        if (!name) continue;
        for (const ref of [r.DurableId, r.Label]) if (str(ref)) objectByRef.set(key(ref as string), name);
      }
    });
    attempt("record counts", () => {
      const rows = run([
        "org",
        "list",
        "sobject",
        "record-counts",
        "--target-org",
        org,
        ...objects.flatMap((o) => ["--sobject", o]),
      ]) as { name?: string; count?: number }[] | undefined;
      for (const r of rows ?? []) if (r.name && typeof r.count === "number") ctx.recordCounts[r.name] = r.count;
    });
  }

  const packageByNamespace = new Map<string, string>();
  attempt("installed packages", () => {
    const rows = query(
      run,
      org,
      "SELECT SubscriberPackage.NamespacePrefix, SubscriberPackage.Name, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion FROM InstalledSubscriberPackage",
      true,
    );
    for (const r of rows) {
      const name = str(field(r, "SubscriberPackage.Name")) ?? "unknown package";
      const namespace = str(field(r, "SubscriberPackage.NamespacePrefix"));
      const version = ["MajorVersion", "MinorVersion", "PatchVersion"]
        .map((f) => field(r, `SubscriberPackageVersion.${f}`))
        .filter((v) => v !== undefined && v !== null)
        .join(".");
      ctx.packages.push({ namespace, name, version });
      if (namespace) packageByNamespace.set(key(namespace), name);
    }
  });

  const objectOf = (...refs: unknown[]): string | undefined => {
    for (const r of refs) {
      const hit = str(r) && objectByRef.get(key(r as string));
      if (hit) return hit;
    }
    return undefined;
  };
  const owner = (ns: unknown) => {
    const namespace = str(ns);
    return { namespace, packageName: namespace ? packageByNamespace.get(key(namespace)) : undefined };
  };

  if (objects.length) {
    attempt("flows", () => {
      const rows = query(
        run,
        org,
        "SELECT ApiName, TriggerType, RecordTriggerType, TriggerObjectOrEventId, TriggerObjectOrEventLabel, NamespacePrefix FROM FlowDefinitionView WHERE IsActive = true",
      );
      for (const r of rows) {
        const timing = FLOW_TIMING[str(r.TriggerType) ?? ""];
        const name = str(r.ApiName);
        if (!timing || !name) continue;
        const object = objectOf(r.TriggerObjectOrEventId, r.TriggerObjectOrEventLabel);
        if (!object || model.flows.has(key(name))) continue;
        const events =
          str(r.TriggerType) === "RecordBeforeDelete"
            ? ["delete"]
            : (RECORD_TRIGGER_EVENTS[str(r.RecordTriggerType) ?? ""] ?? []);
        ctx.orgOnlyAutomation.push({
          kind: "Flow",
          name,
          object,
          when: events.map((e) => `${timing} ${e}`),
          ...owner(r.NamespacePrefix),
        });
      }
    });
    attempt("triggers", () => {
      const rows = query(
        run,
        org,
        `SELECT Name, TableEnumOrId, NamespacePrefix, ${TRIGGER_USAGE.map(([f]) => f).join(", ")} FROM ApexTrigger WHERE Status = 'Active'`,
      );
      for (const r of rows) {
        const name = str(r.Name);
        const object = objectOf(r.TableEnumOrId);
        if (!name || !object || model.triggers.has(key(name))) continue;
        ctx.orgOnlyAutomation.push({
          kind: "ApexTrigger",
          name,
          object,
          when: TRIGGER_USAGE.filter(([f]) => r[f] === true).map(([, label]) => label),
          ...owner(r.NamespacePrefix),
        });
      }
    });
    attempt("validation rules", () => {
      const rows = query(
        run,
        org,
        "SELECT ValidationName, EntityDefinitionId, NamespacePrefix FROM ValidationRule WHERE Active = true",
        true,
      );
      const inProject = new Set(model.validationRules.map((v) => key(v.fullName)));
      for (const r of rows) {
        const name = str(r.ValidationName);
        const object = objectOf(r.EntityDefinitionId);
        if (!name || !object || inProject.has(key(`${object}.${name}`))) continue;
        ctx.orgOnlyAutomation.push({
          kind: "ValidationRule",
          name,
          object,
          when: ["validation"],
          ...owner(r.NamespacePrefix),
        });
      }
    });
  }

  // Who holds the changed permission sets / profiles (direct assignments, active users only).
  const changedPerms = result.changes.filter(
    (c) => (c.component.type === "PermissionSet" || c.component.type === "Profile") && c.changeType !== "deleted",
  );
  const permSets = changedPerms.filter((c) => c.component.type === "PermissionSet").map((c) => c.component.name);
  const profiles = changedPerms
    .filter((c) => c.component.type === "Profile")
    .map((c) => {
      const decoded = safeDecode(c.component.name);
      return { file: c.component.name, orgName: STANDARD_PROFILES[key(decoded)] ?? decoded };
    });
  if (permSets.length) {
    attempt("permission set assignments", () => {
      const sets = query(
        run,
        org,
        `SELECT Id, Name FROM PermissionSet WHERE IsOwnedByProfile = false AND Name IN (${soqlList(permSets)})`,
      );
      const ids = sets.map((s) => s.Id).filter(isId);
      const counts = new Map<string, number>();
      if (ids.length) {
        const rows = query(
          run,
          org,
          `SELECT PermissionSetId, COUNT(Id) n FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND PermissionSetId IN (${ids.map((i) => `'${i}'`).join(", ")}) GROUP BY PermissionSetId`,
        );
        for (const r of rows) if (isId(r.PermissionSetId)) counts.set(r.PermissionSetId, Number(r.n ?? 0));
      }
      for (const name of permSets) {
        const set = sets.find((s) => key(String(s.Name)) === key(name));
        if (set) ctx.assignments.push({ kind: "PermissionSet", name, activeUsers: counts.get(String(set.Id)) ?? 0 });
      }
    });
  }
  if (profiles.length) {
    attempt("profile assignments", () => {
      const rows = query(
        run,
        org,
        `SELECT Id, Name FROM Profile WHERE Name IN (${soqlStringList(profiles.map((p) => p.orgName))})`,
      );
      const ids = rows.map((r) => r.Id).filter(isId);
      const counts = new Map<string, number>();
      if (ids.length) {
        const users = query(
          run,
          org,
          `SELECT ProfileId, COUNT(Id) n FROM User WHERE IsActive = true AND ProfileId IN (${ids.map((i) => `'${i}'`).join(", ")}) GROUP BY ProfileId`,
        );
        for (const u of users) if (isId(u.ProfileId)) counts.set(u.ProfileId, Number(u.n ?? 0));
      }
      for (const p of profiles) {
        const row = rows.find((r) => key(String(r.Name)) === key(p.orgName));
        if (row) ctx.assignments.push({ kind: "Profile", name: p.file, activeUsers: counts.get(String(row.Id)) ?? 0 });
      }
    });
  }

  return ctx;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const describe = (a: OrgAutomation) => {
  const kind = a.kind === "ApexTrigger" ? "trigger" : a.kind === "Flow" ? "flow" : "validation rule";
  const when = a.kind === "ValidationRule" ? "" : a.when.length ? ` (${a.when.join(", ")})` : "";
  const pkg = a.packageName ? ` [${a.packageName}]` : a.namespace ? ` [${a.namespace}]` : "";
  return `${kind} ${a.namespace ? `${a.namespace}__` : ""}${a.name}${when}${pkg}`;
};

const metadataSpec = (a: OrgAutomation) =>
  a.kind === "ValidationRule" ? `ValidationRule:${a.object}.${a.name}` : `${a.kind}:${a.name}`;

/** Add org findings and annotations to an analysis result (mutates and returns it). */
export function applyOrgContext(result: AnalysisResult, ctx: OrgContext): AnalysisResult {
  const findings: Finding[] = [...result.findings];

  const byObject = new Map<string, OrgAutomation[]>();
  for (const a of ctx.orgOnlyAutomation) {
    const list = byObject.get(a.object) ?? [];
    list.push(a);
    byObject.set(a.object, list);
  }
  for (const [object, list] of byObject) {
    const managed = list.filter((a) => a.namespace);
    const unmanaged = list.filter((a) => !a.namespace);
    findings.push({
      rule: "org-only-automation",
      severity: unmanaged.length ? "medium" : "low",
      title: `${list.length} automation(s) on ${object} run in ${ctx.org} but aren't in this project`,
      detail:
        `${list.map(describe).join("; ")}. Their effects are not in the cascade above. ` +
        (unmanaged.length
          ? `Retrieve them so preflight can analyze them: \`sf project retrieve start ${unmanaged
              .map((a) => `--metadata ${metadataSpec(a)}`)
              .join(" ")}\`. `
          : "") +
        (managed.length
          ? "Managed-package automation can't be retrieved as source but still runs: keep it enabled in tests."
          : ""),
      object,
      files: [],
    });
  }

  for (const a of ctx.assignments) {
    for (const f of findings) {
      if (!f.rule.startsWith("permission-")) continue;
      const matches = f.title.includes(`${a.kind === "Profile" ? "Profile" : "Permission set"} ${a.name} `);
      if (!matches) continue;
      f.detail += ` In ${ctx.org} it is assigned to ${a.activeUsers.toLocaleString("en-US")} active user(s).`;
    }
  }

  for (const t of result.suggestedTests) {
    if (t.kind !== "bulk" || !t.object) continue;
    const count = ctx.recordCounts[t.object];
    if (count === undefined) continue;
    t.description = t.description.replace(
      "(and at your expected production volume)",
      `(${ctx.org} has ${count.toLocaleString("en-US")} ${t.object} records — test at a realistic share of that volume)`,
    );
  }

  const summary = summarizeFindings(findings);
  result.findings = summary.findings;
  result.summary.findingsBySeverity = summary.findingsBySeverity;
  result.summary.risk = summary.risk;
  result.org = ctx;
  return result;
}

export function enrichWithOrg(model: OrgModel, result: AnalysisResult, opts: OrgEnrichOptions): AnalysisResult {
  return applyOrgContext(result, collectOrgContext(model, result, opts));
}
