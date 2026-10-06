// SPDX-License-Identifier: Apache-2.0
import { allAgentActions } from "../agentImpact.js";
import { analyze } from "../analyze.js";
import { assertSafeRef, git, gitChangedFiles, gitRoot, gitShow, isShallow, toChanges } from "../changes.js";
import { callersOfClass, callersOfFlow, knownClassRefs, writersOf } from "../graph.js";
import type { AnalysisResult, Change, ChangeType, ComponentType, OrgModel, SaveEvent } from "../types.js";
import { key, redactEmails, uniq } from "../util.js";
import { CATEGORY_RULES, type ErrorVocabulary } from "./classify.js";
import type { FailingComponent, Incident, IncidentCollection } from "./collect.js";

/**
 * Traces production errors back to the changes that most likely caused them. Each recent change
 * on the branch (first-parent history: one entry per merged pull request or pushed commit) is
 * analysed component by component, and an error points at a change when:
 *
 * - the change touched the failing component, or one in its call stack (direct),
 * - the error is the message of a validation rule the change added or changed, or names a field
 *   it changed (message),
 * - the failing component is in the change's blast radius: it runs in a save the change affects,
 *   saves records a changed rule or trigger applies to, or calls changed code (blast radius),
 * - and preflight's own findings for the change predicted this kind of failure (finding).
 *
 * Timing then weighs in: errors seen before a change was merged can't have been caused by it.
 */

export interface ChangeRef {
  sha: string;
  shortSha: string;
  /** Commit date (ISO). */
  date: string;
  subject: string;
  pr?: number;
}

export interface HistoryChange extends ChangeRef {
  parent: string;
  files: { file: string; changeType: ChangeType; previousFile?: string }[];
  changes: Change[];
}

export interface SuspectComponent {
  type: ComponentType;
  name: string;
  file: string;
  changeType: ChangeType;
}

export interface Suspect {
  change: ChangeRef;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  /** Components of the change the evidence points to: what a partial rollback would cover. */
  components: SuspectComponent[];
}

export interface TracedIncident extends Incident {
  suspects: Suspect[];
}

export interface IncidentReport extends Omit<IncidentCollection, "incidents"> {
  incidents: TracedIncident[];
  history: { ref: string; changes: number; from?: string; to?: string; shallow: boolean };
}

const PR = [/Merge pull request #(\d+)/, /\(#(\d+)\)\s*$/];
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A commit's title and pull request number. Merge commits ("Merge pull request #12 from …") carry
 * the pull request title in their body; squash merges end with "(#12)".
 */
export function commitTitle(root: string, sha: string, subject: string): { subject: string; pr?: number } {
  const pr = PR.map((re) => re.exec(subject)?.[1]).find(Boolean);
  let title = subject.replace(/\s*\(#\d+\)\s*$/, "");
  if (/^Merge pull request #\d+/.test(subject)) {
    try {
      const body = git(root, ["log", "-1", "--no-show-signature", "--format=%b", sha])
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      if (body) title = body;
    } catch {
      // keep the merge subject
    }
  }
  return { subject: clip(redactEmails(title)), ...(pr ? { pr: Number(pr) } : {}) };
}

/** Recent changes on a branch, newest first: first-parent commits that touched the project. */
export function recentChanges(
  projectDir: string,
  opts: { ref?: string; since: Date; max?: number },
): { changes: HistoryChange[]; shallow: boolean; ref: string } {
  const ref = assertSafeRef(opts.ref ?? "HEAD", "ref");
  const max = opts.max ?? 50;
  const root = gitRoot(projectDir);
  if (!root) throw new Error(`Not a git repository: ${projectDir}`);
  const log = git(root, [
    "log",
    "--first-parent",
    "--no-show-signature",
    "--format=%H%x1f%P%x1f%cI%x1f%s",
    `--since=${opts.since.toISOString()}`,
    "-n",
    String(max * 4),
    ref,
    "--",
  ]);
  const changes: HistoryChange[] = [];
  for (const line of log.split("\n")) {
    if (changes.length >= max) break;
    const [sha, parents, date, subject = ""] = line.split("\x1f");
    const parent = parents?.split(" ")[0];
    if (!sha || !parent || !date || !/^[0-9a-f]{40,64}$/.test(sha) || !/^[0-9a-f]{40,64}$/.test(parent)) continue;
    const files = gitChangedFiles({ projectDir, base: parent, head: sha });
    const { changes: comps } = toChanges(files);
    if (!comps.length) continue;
    changes.push({
      sha,
      shortSha: sha.slice(0, 7),
      date: new Date(date).toISOString(),
      ...commitTitle(root, sha, subject),
      parent,
      files,
      changes: comps,
    });
  }
  return { changes, shallow: isShallow(root), ref };
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Names and messages from the change history that the current project may no longer have: rules
 * whose message changed, deleted fields and triggers.
 */
export function historyVocabulary(projectDir: string, history: HistoryChange[]): Partial<ErrorVocabulary> {
  const validationRules: { name: string; message: string }[] = [];
  const fields: string[] = [];
  const triggers: string[] = [];
  for (const h of history) {
    for (const c of h.changes) {
      const comp = c.component;
      if (comp.type === "CustomField") fields.push(comp.name);
      if (comp.type === "ApexTrigger") triggers.push(comp.name);
      if (comp.type !== "ValidationRule") continue;
      const versions = [
        c.changeType !== "deleted" ? gitShow(projectDir, h.sha, comp.file) : undefined,
        c.changeType !== "added" ? gitShow(projectDir, h.parent, c.previousFile ?? comp.file) : undefined,
      ];
      for (const xml of versions) {
        const m = xml && /<errorMessage>([\s\S]{1,1000}?)<\/errorMessage>/.exec(xml);
        if (m?.[1]?.trim()) validationRules.push({ name: comp.name, message: decodeXml(m[1]) });
      }
    }
  }
  return { validationRules, fields, triggers };
}

// ---------------------------------------------------------------------------------------------
// Blast radius per changed component
// ---------------------------------------------------------------------------------------------

type Kind = "flow" | "apexclass" | "apextrigger" | "validationrule" | "customfield" | "agentaction";
const ck = (kind: Kind, name: string) => `${kind}:${key(name)}`;

const PAST: Record<SaveEvent, string> = {
  insert: "created",
  update: "updated",
  delete: "deleted",
  undelete: "undeleted",
};

const KIND_LABEL: Record<string, string> = {
  Flow: "flow",
  ApexClass: "Apex class",
  ApexTrigger: "trigger",
  ValidationRule: "validation rule",
  CustomField: "field",
  AgentAction: "agent action",
  AgentMetadata: "agent metadata",
  PermissionSet: "permission set",
  Profile: "profile",
  CustomObject: "object",
  WorkflowRule: "workflow rule",
  ObjectChild: "object setting",
  Unknown: "component",
};
const VERB: Record<ChangeType, string> = {
  added: "added",
  modified: "changed",
  deleted: "deleted",
  renamed: "renamed",
};

export const describeComponent = (type: string, name: string) => `${KIND_LABEL[type] ?? "component"} \`${name}\``;

function failingKey(c: FailingComponent, actions: Map<string, string>): string | undefined {
  switch (c.kind) {
    case "Flow":
      return ck("flow", c.name);
    case "ApexClass":
      return ck("apexclass", c.name);
    case "ApexTrigger":
      return ck("apextrigger", c.name);
    case "AgentAction":
      return ck("agentaction", actions.get(key(c.name)) ?? c.name);
    default:
      return undefined;
  }
}

function changeKey(c: Change): string | undefined {
  const name = c.component.name;
  switch (c.component.type) {
    case "Flow":
      return ck("flow", name);
    case "ApexClass":
      return ck("apexclass", name);
    case "ApexTrigger":
      return ck("apextrigger", name);
    case "ValidationRule":
      return ck("validationrule", name);
    case "CustomField":
      return ck("customfield", name);
    default:
      return undefined;
  }
}

interface ComponentImpact {
  change: Change;
  result: AnalysisResult;
  /** Keys the change touches directly (the component, or agent actions defined in its file). */
  direct: Set<string>;
  /** Failing-component key → how it relates to the change, e.g. "runs when Opportunity records are updated". */
  involved: Map<string, string>;
}

function componentImpact(
  model: OrgModel,
  change: Change,
  readBase?: (file: string) => string | undefined,
): ComponentImpact {
  const result = analyze({ model, changes: [change], maxDepth: 4, readBase });
  const direct = new Set<string>();
  const involved = new Map<string, string>();
  const add = (k: string, why: string) => {
    if (!direct.has(k) && !involved.has(k)) involved.set(k, why);
  };
  const own = changeKey(change);
  if (own) direct.add(own);
  for (const a of result.agents) {
    const defined = change.component.type === "AgentMetadata";
    if (defined) direct.add(ck("agentaction", a.action));
    else add(ck("agentaction", a.action), a.reasons[0] ?? "is affected by it");
  }

  // Automations that run in the saves the change affects, and the classes they call.
  const viaClasses = (from: string[], why: string, depth = 0) => {
    for (const cls of knownClassRefs(model, from)) {
      const k = ck("apexclass", cls.name);
      if (direct.has(k) || involved.has(k)) continue;
      add(k, why);
      if (depth < 2) viaClasses(cls.classRefs, why, depth + 1);
    }
  };
  for (const sp of result.saveProcedures) {
    for (const step of sp.steps) {
      const a = step.automation;
      const why = `runs when ${sp.object} records are ${PAST[sp.event]}`;
      if (a.kind === "Flow") {
        add(ck("flow", a.name), why);
        viaClasses(model.flows.get(key(a.name))?.apexActions ?? [], `is called by flow \`${a.name}\`, which ${why}`);
      } else if (a.kind === "ApexTrigger") {
        add(ck("apextrigger", a.name), why);
        viaClasses(
          model.triggers.get(key(a.name))?.classRefs ?? [],
          `is called by trigger \`${a.name}\`, which ${why}`,
        );
      } else if (a.kind === "ValidationRule") add(ck("validationrule", a.name), why);
      else if (a.kind === "ApexClass") add(ck("apexclass", a.name), why);
    }
  }

  // Automations that save records a changed rule, field, trigger or record-triggered flow applies to.
  const comp = change.component;
  const anchor =
    comp.type === "ValidationRule" || comp.type === "CustomField"
      ? comp.object
      : comp.type === "ApexTrigger"
        ? model.triggers.get(key(comp.name))?.object
        : comp.type === "Flow"
          ? model.flows.get(key(comp.name))?.trigger?.object
          : undefined;
  if (anchor) {
    for (const w of writersOf(model, anchor)) {
      const k =
        w.automation.kind === "Flow"
          ? ck("flow", w.automation.name)
          : w.automation.kind === "ApexTrigger"
            ? ck("apextrigger", w.automation.name)
            : ck("apexclass", w.automation.name);
      add(k, `saves ${anchor} records, where ${describeComponent(comp.type, comp.name)} applies`);
    }
  }

  // Code and flows that call changed code.
  if (comp.type === "ApexClass") {
    const seen = new Set<string>([key(comp.name)]);
    let frontier = [comp.name];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const name of frontier) {
        for (const caller of callersOfClass(model, name)) {
          const kind: Kind =
            caller.kind === "Flow" ? "flow" : caller.kind === "ApexTrigger" ? "apextrigger" : "apexclass";
          add(ck(kind, caller.name), depth === 0 ? `calls \`${comp.name}\`` : `calls code that calls \`${comp.name}\``);
          if (caller.kind === "ApexClass" && !seen.has(key(caller.name))) {
            seen.add(key(caller.name));
            next.push(caller.name);
          }
        }
      }
      frontier = next;
    }
  }
  if (comp.type === "Flow") {
    for (const parent of callersOfFlow(model, comp.name))
      add(ck("flow", parent.name), `runs \`${comp.name}\` as a subflow`);
  }
  for (const ref of allAgentActions(model)) {
    const target = ref.action.target;
    if (!target) continue;
    const t = ref.action.targetType.toLowerCase();
    const calls =
      (comp.type === "ApexClass" && t === "apex" && key(target) === key(comp.name)) ||
      (comp.type === "Flow" && t === "flow" && key(target) === key(comp.name));
    if (calls) add(ck("agentaction", ref.action.name), `runs \`${comp.name}\``);
  }
  return { change, result, direct, involved };
}

// ---------------------------------------------------------------------------------------------
// Matching and scoring
// ---------------------------------------------------------------------------------------------

function fileOf(model: OrgModel, c: FailingComponent): string | undefined {
  if (c.kind === "Flow") return model.flows.get(key(c.name))?.file;
  if (c.kind === "ApexClass") return model.classes.get(key(c.name))?.file;
  if (c.kind === "ApexTrigger") return model.triggers.get(key(c.name))?.file;
  return undefined;
}

const failingLabel = (c: FailingComponent) => describeComponent(c.kind, c.name);

function since(from: string, to: string): string {
  const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  if (hours < 1) return "within the hour";
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

const day = (iso: string) => iso.slice(0, 10);

interface Evidence {
  kind: "direct" | "message" | "blast" | "finding";
  strength: number;
  text: string;
}

function evaluateComponent(
  model: OrgModel,
  incident: Incident,
  impact: ComponentImpact,
  actions: Map<string, string>,
): Evidence[] {
  const out: Evidence[] = [];
  const comp = impact.change.component;
  const what = `${VERB[impact.change.changeType]} ${describeComponent(comp.type, comp.name)}`;
  const primary = failingKey(incident.component, actions);
  const via = incident.via.map((v) => ({ v, k: failingKey(v, actions) }));
  const sig = incident.signature;

  if (primary && impact.direct.has(primary)) {
    out.push({ kind: "direct", strength: 60, text: `It ${what}, where the error happens.` });
  } else {
    const hit = via.find((x) => x.k && impact.direct.has(x.k));
    if (hit) {
      out.push({
        kind: "direct",
        strength: 45,
        text: `It ${what}, which is part of the failing call (${failingLabel(hit.v)}).`,
      });
    }
  }
  if (comp.type === "ValidationRule" && sig.validationRule && key(sig.validationRule) === key(comp.name)) {
    out.push({ kind: "message", strength: 65, text: `It ${what}, and the error is that rule's message.` });
  }
  if (comp.type === "CustomField" && sig.fields.some((f) => key(f) === key(comp.name))) {
    out.push({
      kind: "message",
      strength: impact.change.changeType === "deleted" || sig.category === "required-field" ? 55 : 40,
      text: `It ${what}, which the error names.`,
    });
  }
  if (!out.length && primary) {
    const why = impact.involved.get(primary);
    if (why)
      out.push({ kind: "blast", strength: 25, text: `It ${what}, and ${failingLabel(incident.component)} ${why}.` });
  }
  // Preflight's findings for the change that predicted this kind of failure.
  const rules = new Set(CATEGORY_RULES[sig.category]);
  const files = [incident.component, ...incident.via].map((c) => fileOf(model, c)).filter(Boolean);
  const finding = impact.result.findings.find(
    (f) =>
      rules.has(f.rule) && (f.files.some((x) => files.includes(x)) || (out.length > 0 && f.files.includes(comp.file))),
  );
  if (finding) {
    out.push({
      kind: "finding",
      strength: out.length ? 15 : 20,
      text: `Preflight flagged it for this change: ${finding.title}.`,
    });
  }
  return out;
}

export interface TraceOptions {
  model: OrgModel;
  collection: IncidentCollection;
  history: { changes: HistoryChange[]; shallow: boolean; ref: string };
  projectDir: string;
  /** When each component last changed in the org ("Kind:name" lower-cased → ISO), if known. */
  orgDates?: Map<string, string>;
}

/** Org date key for a component, e.g. "apexclass:opportunitycloser". */
export const orgDateKey = (type: ComponentType, name: string) => `${type.toLowerCase()}:${key(name)}`;

export function traceIncidents(opts: TraceOptions): IncidentReport {
  const { model, collection, history } = opts;
  const actions = new Map<string, string>();
  for (const ref of allAgentActions(model)) {
    for (const n of [ref.action.name, ...(ref.action.aliases ?? [])]) actions.set(key(n), ref.action.name);
  }
  const impacts = new Map<string, ComponentImpact[]>();
  const impactsOf = (h: HistoryChange) => {
    let list = impacts.get(h.sha);
    if (!list) {
      list = h.changes.map((c) => componentImpact(model, c, (file) => gitShow(opts.projectDir, h.parent, file)));
      impacts.set(h.sha, list);
    }
    return list;
  };

  const incidents = collection.incidents.map((incident): TracedIncident => {
    const suspects: Suspect[] = [];
    for (const h of history.changes) {
      if (h.date > incident.lastSeen) continue; // merged after the last error: not the cause
      const scored = impactsOf(h)
        .map((impact) => ({ impact, evidence: evaluateComponent(model, incident, impact, actions) }))
        .filter((x) => x.evidence.length);
      if (!scored.length) continue;
      const best = Math.max(
        ...scored.map(({ evidence }) => {
          const base = Math.max(0, ...evidence.filter((e) => e.kind !== "finding").map((e) => e.strength));
          const finding = evidence.find((e) => e.kind === "finding");
          return base ? base + (finding ? 15 : 0) : (finding?.strength ?? 0);
        }),
      );
      let score = best + Math.min(10, 3 * (scored.length - 1));
      const reasons = uniq(scored.flatMap((x) => x.evidence.map((e) => e.text)));
      const components = scored.map(({ impact: { change } }) => ({
        type: change.component.type,
        name: change.component.name,
        file: change.component.file,
        changeType: change.changeType,
      }));

      // Timing: in the org, when known; otherwise the merge.
      const dates = components
        .map((c) => ({ c, at: opts.orgDates?.get(orgDateKey(c.type, c.name)) }))
        .filter((x): x is { c: SuspectComponent; at: string } => !!x.at);
      if (incident.firstSeen < h.date) {
        score *= 0.35;
        reasons.push(
          `These errors were already happening before it was merged (first seen ${day(incident.firstSeen)}).`,
        );
      } else if (dates.some((d) => Date.parse(d.at) < Date.parse(h.date) - 3_600_000)) {
        const old = dates.find((d) => Date.parse(d.at) < Date.parse(h.date) - 3_600_000)!;
        score *= 0.5;
        reasons.push(
          `The org's ${describeComponent(old.c.type, old.c.name)} last changed ${day(old.at)}, before this change, so it may not be deployed there.`,
        );
      } else if (dates.length) {
        const latest = dates.sort((a, b) => (a.at < b.at ? 1 : -1))[0]!;
        if (incident.firstSeen >= latest.at) {
          score += 10;
          reasons.push(
            `The errors started ${since(latest.at, incident.firstSeen)} after ${describeComponent(latest.c.type, latest.c.name)} changed in the org (${day(latest.at)}).`,
          );
        }
      } else if (Date.parse(incident.firstSeen) - Date.parse(h.date) <= 72 * 3_600_000) {
        score += 10;
        reasons.push(`The errors started ${since(h.date, incident.firstSeen)} after it was merged.`);
      }
      score = Math.round(Math.min(100, score));
      if (score < 15) continue;
      const { parent: _p, files: _f, changes: _c, ...change } = h;
      suspects.push({
        change,
        score,
        confidence: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
        reasons,
        components,
      });
    }
    suspects.sort((a, b) => b.score - a.score || (a.change.date < b.change.date ? 1 : -1));
    return { ...incident, suspects: suspects.slice(0, 3) };
  });

  const dates = history.changes.map((h) => h.date).sort();
  return {
    ...collection,
    incidents,
    history: {
      ref: history.ref,
      changes: history.changes.length,
      ...(dates.length ? { from: dates[0], to: dates.at(-1) } : {}),
      shallow: history.shallow,
    },
  };
}
