// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { orgLabel } from "../org/enrich.js";
import { assertSafeOrg, createSfRunner, field, type QueryRecord, query, SfError, type SfRunner } from "../org/sf.js";
import type { OrgModel } from "../types.js";
import { key, redactEmails } from "../util.js";
import { classifyError, type ErrorSignature, type ErrorVocabulary } from "./classify.js";

/**
 * Collects production errors from an org, read-only: failed flow interviews, unhandled Apex
 * exceptions (the free daily event log), failed asynchronous Apex jobs and, where Data 360
 * session tracing is on, failed Agentforce action steps. Errors can also be imported from a file
 * for anything else (a logging tool, an Agentforce trace export).
 *
 * Every message is classified the moment it's read and then dropped (see classify.ts): what's
 * kept is the failing component, the kind of failure and the metadata it names, with counts and
 * times. No record data, record IDs or user names.
 */

export type IncidentSource = "flow" | "apex" | "async-apex" | "agent" | "imported";

export interface FailingComponent {
  kind: "Flow" | "ApexClass" | "ApexTrigger" | "AgentAction" | "Unknown";
  name: string;
  /** Flow element, or the topic of an agent action. */
  element?: string;
}

export interface IncidentEvent {
  source: IncidentSource;
  component: FailingComponent;
  /** Other components involved: callers in the Apex stack, triggers named in the message. */
  via: FailingComponent[];
  signature: ErrorSignature;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Errors with the same component and signature, grouped. */
export interface Incident extends IncidentEvent {
  id: string;
}

export interface SourceStatus {
  source: IncidentSource;
  label: string;
  status: "ok" | "unavailable" | "error";
  /** Errors read from this source. */
  events: number;
  note?: string;
}

export interface IncidentCollection {
  /** Org alias, never a username; absent when errors were only imported. */
  org?: string;
  since: string;
  until: string;
  sources: SourceStatus[];
  incidents: Incident[];
}

const SOURCE_LABEL: Record<IncidentSource, string> = {
  flow: "Failed flow interviews",
  apex: "Unhandled Apex exceptions",
  "async-apex": "Failed asynchronous Apex",
  agent: "Agentforce action errors (beta)",
  imported: "Imported errors",
};

/** A source the org doesn't have (feature off, no permission, older CLI). */
class Unavailable extends Error {}

const UNAVAILABLE =
  /not supported|INVALID_TYPE|does not exist|no such column|insufficient|not found|isn't a sf command|is not a sf command|not a valid command|requested resource/i;

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{15,18}$/.test(v);
const ident = (v: unknown, max = 120): string | undefined =>
  typeof v === "string" && new RegExp(`^[A-Za-z][A-Za-z0-9_.]{0,${max}}$`).test(v) ? v : undefined;
const iso = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const soqlDateTime = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

/** "7d", "24h", "2w", or a date/time. */
export function parseSince(value: string, now = new Date()): Date {
  const m = /^(\d{1,4})([hdw])$/.exec(value.trim());
  if (m) {
    const hours = Number(m[1]) * (m[2] === "h" ? 1 : m[2] === "d" ? 24 : 168);
    if (hours < 1 || hours > 24 * 366) throw new Error(`--since must be between 1h and 366d: ${value}`);
    return new Date(now.getTime() - hours * 3_600_000);
  }
  const d = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim()) ? new Date(value) : undefined;
  if (!d || Number.isNaN(d.getTime())) throw new Error(`--since takes a duration (7d, 24h, 2w) or a date: ${value}`);
  return d;
}

interface Ctx {
  run: SfRunner;
  org: string;
  since: Date;
  vocab: ErrorVocabulary;
  model: OrgModel;
}

function describeFields(
  ctx: Ctx,
  sobject: string,
): { name: string; type: string; picklistValues?: { value: string }[] }[] {
  try {
    const r = ctx.run(["sobject", "describe", "--sobject", sobject, "--target-org", ctx.org]) as {
      fields?: { name: string; type: string; picklistValues?: { value: string }[] }[];
    };
    return r?.fields ?? [];
  } catch (err) {
    if (UNAVAILABLE.test((err as Error).message)) throw new Unavailable(`${sobject} isn't available`);
    throw err;
  }
}

function event(
  source: IncidentSource,
  component: FailingComponent,
  via: FailingComponent[],
  signature: ErrorSignature,
  at: string,
): IncidentEvent {
  const triggers = signature.triggers
    .filter((t) => !(component.kind === "ApexTrigger" && key(component.name) === key(t)))
    .map((t): FailingComponent => ({ kind: "ApexTrigger", name: t }));
  return { source, component, via: [...via, ...triggers], signature, count: 1, firstSeen: at, lastSeen: at };
}

// ---------------------------------------------------------------------------------------------
// Failed flow interviews
// ---------------------------------------------------------------------------------------------

function flowErrors(ctx: Ctx): IncidentEvent[] {
  const fields = describeFields(ctx, "FlowInterview");
  const status = fields.find((f) => f.name === "InterviewStatus");
  if (!status?.picklistValues?.some((p) => p.value === "Error")) {
    throw new Unavailable("this org doesn't keep failed flow interviews");
  }
  const has = (n: string) => fields.some((f) => f.name === n);
  const errorField = fields.find((f) => /error/i.test(f.name) && /string|textarea/i.test(f.type))?.name;
  const select = ["FlowVersionViewId", "CurrentElement", "InterviewLabel", "CreatedDate", errorField].filter(
    (f): f is string => !!f && has(f),
  );
  const rows = query(
    ctx.run,
    ctx.org,
    `SELECT ${select.join(", ")} FROM FlowInterview WHERE InterviewStatus = 'Error' AND CreatedDate >= ${soqlDateTime(ctx.since)} ORDER BY CreatedDate DESC LIMIT 2000`,
  );
  const names = flowNames(ctx, rows.map((r) => r.FlowVersionViewId).filter(isId));
  const labels = [...ctx.model.flows.values()].filter((f) => f.label).sort((a, b) => b.label!.length - a.label!.length);
  return rows.map((r) => {
    const id = isId(r.FlowVersionViewId) ? r.FlowVersionViewId.slice(0, 15) : undefined;
    const label = typeof r.InterviewLabel === "string" ? r.InterviewLabel : "";
    // The interview label starts with the flow's label unless the flow customises it.
    const name = (id && names.get(id)) ?? labels.find((f) => label.startsWith(f.label!))?.name ?? "(unknown flow)";
    const element = ident(r.CurrentElement, 80);
    const signature = classifyError(errorField ? (r[errorField] as string | undefined) : undefined, ctx.vocab);
    return event(
      "flow",
      { kind: "Flow", name, ...(element ? { element } : {}) },
      [],
      signature,
      iso(r.CreatedDate) ?? ctx.since.toISOString(),
    );
  });
}

/** Flow API names for flow version IDs, from the Tooling API (15-character keys). */
function flowNames(ctx: Ctx, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.map((i) => i.slice(0, 15)))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = ids.filter((id) => unique.slice(i, i + 100).includes(id.slice(0, 15)));
    try {
      const rows = query(
        ctx.run,
        ctx.org,
        `SELECT Id, Definition.DeveloperName FROM Flow WHERE Id IN (${[...new Set(chunk)].map((x) => `'${x}'`).join(", ")})`,
        true,
      );
      for (const r of rows) {
        const name = ident(field(r, "Definition.DeveloperName"));
        if (isId(r.Id) && name) out.set(r.Id.slice(0, 15), name);
      }
    } catch {
      // Fall back to matching interview labels.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Unhandled Apex exceptions (EventLogFile, ApexUnexpectedException)
// ---------------------------------------------------------------------------------------------

/** Minimal RFC 4180 CSV parser (quoted fields may contain commas, quotes and newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.some((c) => c !== ""));
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** Components in an Apex stack trace, innermost first: "Class.Foo.bar: line 3, column 1". */
export function parseStack(stack: string, model: OrgModel): FailingComponent[] {
  const out: FailingComponent[] = [];
  for (const line of stack.split(/\r?\n|\\n/)) {
    const m = /^\s*(Class|Trigger)\.([A-Za-z0-9_.]{1,200})/.exec(line);
    if (!m) continue;
    const parts = m[2]!.split(".").filter(Boolean);
    let c: FailingComponent | undefined;
    if (m[1] === "Trigger") {
      const t = model.triggers.get(key(parts[0]!));
      c = { kind: "ApexTrigger", name: t?.name ?? parts[0]! };
    } else {
      const known = parts.map((p) => model.classes.get(key(p))).find(Boolean);
      const name = known?.name ?? (parts.length >= 3 ? `${parts[0]}.${parts[1]}` : parts[0]!);
      c = { kind: "ApexClass", name };
    }
    if (!out.some((o) => o.kind === c.kind && key(o.name) === key(c.name))) out.push(c);
  }
  return out;
}

/** "20261006093000.123" → ISO. */
function eventLogTime(row: Record<string, string>): string | undefined {
  const derived = iso(row.TIMESTAMP_DERIVED);
  if (derived) return derived;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(row.TIMESTAMP ?? "");
  return m ? iso(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : undefined;
}

const LOG_FILE_URL = /^\/services\/data\/v\d{2,3}\.\d\/sobjects\/EventLogFile\/[A-Za-z0-9]{15,18}\/LogFile$/;

function apexErrors(ctx: Ctx): IncidentEvent[] {
  const day = `${ctx.since.toISOString().slice(0, 10)}T00:00:00Z`;
  const soql = (withInterval: boolean) =>
    `SELECT Id, LogDate, ${withInterval ? "Interval, " : ""}LogFile FROM EventLogFile WHERE EventType = 'ApexUnexpectedException' AND LogDate >= ${day} ORDER BY LogDate DESC LIMIT 60`;
  let files: QueryRecord[];
  try {
    files = query(ctx.run, ctx.org, soql(true));
  } catch (err) {
    if (!/interval/i.test((err as Error).message)) {
      if (UNAVAILABLE.test((err as Error).message)) throw new Unavailable("the org's event log files aren't available");
      throw err;
    }
    files = query(ctx.run, ctx.org, soql(false));
  }
  // Orgs with Event Monitoring have hourly files too; use one interval so nothing counts twice.
  const daily = files.filter((f) => f.Interval === "Daily");
  const use = daily.length ? daily : files.filter((f) => f.Interval === undefined || f.Interval === "Hourly");
  const events: IncidentEvent[] = [];
  for (const f of use) {
    const url = typeof f.LogFile === "string" ? f.LogFile : "";
    if (!LOG_FILE_URL.test(url)) continue;
    let csv: string;
    try {
      csv = String(ctx.run(["api", "request", "rest", url, "--target-org", ctx.org], { raw: true }));
    } catch (err) {
      if (UNAVAILABLE.test((err as Error).message)) {
        throw new Unavailable("reading event log files needs a Salesforce CLI with `sf api request rest`");
      }
      throw err;
    }
    for (const row of parseCsv(csv)) {
      const at = eventLogTime(row);
      if (!at || at < ctx.since.toISOString()) continue;
      const frames = parseStack(row.STACK_TRACE ?? "", ctx.model);
      const signature = classifyError(row.EXCEPTION_MESSAGE, ctx.vocab, row.EXCEPTION_TYPE);
      const inProject = frames.find((c) =>
        c.kind === "ApexTrigger" ? ctx.model.triggers.has(key(c.name)) : ctx.model.classes.has(key(c.name)),
      );
      const top = inProject ?? frames[0] ?? { kind: "Unknown" as const, name: "(unknown Apex)" };
      events.push(
        event(
          "apex",
          top,
          frames.filter((c) => c !== top),
          signature,
          at,
        ),
      );
    }
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Failed asynchronous Apex
// ---------------------------------------------------------------------------------------------

function asyncApexErrors(ctx: Ctx): IncidentEvent[] {
  const rows = query(
    ctx.run,
    ctx.org,
    `SELECT ApexClass.Name, ApexClass.NamespacePrefix, JobType, ExtendedStatus, CreatedDate, CompletedDate FROM AsyncApexJob WHERE CreatedDate >= ${soqlDateTime(ctx.since)} AND (Status = 'Failed' OR NumberOfErrors > 0) ORDER BY CreatedDate DESC LIMIT 2000`,
  );
  return rows.map((r) => {
    const name = ident(field(r, "ApexClass.Name"), 80);
    const ns = ident(field(r, "ApexClass.NamespacePrefix"), 15);
    const known = name ? ctx.model.classes.get(key(name)) : undefined;
    const component: FailingComponent = name
      ? { kind: "ApexClass", name: known?.name ?? (ns ? `${ns}.${name}` : name) }
      : { kind: "Unknown", name: "(unknown Apex)" };
    const at = iso(r.CompletedDate) ?? iso(r.CreatedDate) ?? ctx.since.toISOString();
    return event("async-apex", component, [], classifyError(r.ExtendedStatus as string | undefined, ctx.vocab), at);
  });
}

// ---------------------------------------------------------------------------------------------
// Agentforce action errors (Data 360 session tracing, beta)
// ---------------------------------------------------------------------------------------------

const AGENT_STEP_DMO = "ssot__AiAgentInteractionStep__dlm";

function agentErrors(ctx: Ctx): IncidentEvent[] {
  let fields: { name: string; type: string }[];
  try {
    fields = describeFields(ctx, AGENT_STEP_DMO);
  } catch (err) {
    if (err instanceof Unavailable) throw new Unavailable("needs Agentforce session tracing in Data 360");
    throw err;
  }
  const find = (re: RegExp) => fields.find((f) => re.test(f.name))?.name;
  const nameField = find(/^ssot__Name__c$/);
  const errorField = find(/ErrorMessageText/i);
  const topicField = find(/TopicApiName/i);
  const timeField =
    find(/^ssot__StartTimestamp__c$/) ??
    fields.find((f) => /datetime/i.test(f.type) && /start|created/i.test(f.name))?.name;
  if (!nameField || !errorField || !timeField) throw new Unavailable("needs Agentforce session tracing in Data 360");
  const rows = query(
    ctx.run,
    ctx.org,
    `SELECT ${[nameField, topicField, errorField, timeField].filter(Boolean).join(", ")} FROM ${AGENT_STEP_DMO} WHERE ${errorField} != null AND ${timeField} >= ${soqlDateTime(ctx.since)} LIMIT 2000`,
  );
  return rows.flatMap((r) => {
    const name = ident(r[nameField], 80);
    if (!name) return [];
    const topic = topicField ? ident(r[topicField], 80) : undefined;
    const at = iso(r[timeField]) ?? ctx.since.toISOString();
    return [
      event(
        "agent",
        { kind: "AgentAction", name, ...(topic ? { element: topic } : {}) },
        [],
        classifyError(r[errorField] as string | undefined, ctx.vocab),
        at,
      ),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Imported errors
// ---------------------------------------------------------------------------------------------

const KINDS = new Set(["Flow", "ApexClass", "ApexTrigger", "AgentAction"]);

/**
 * Errors from a JSON file: a list of
 * `{ component: { kind, name, element? }, message?, exceptionType?, count?, at?, firstSeen?, lastSeen? }`
 * (or `component: "Flow:My_Flow"`). Messages are classified like org errors and then dropped.
 */
export function importErrors(
  raw: unknown,
  vocab: ErrorVocabulary,
  since?: Date,
): { events: IncidentEvent[]; skipped: number } {
  const list = Array.isArray(raw) ? raw : (raw as { errors?: unknown })?.errors;
  if (!Array.isArray(list)) throw new Error('expected a JSON list of errors (or { "errors": [...] })');
  const events: IncidentEvent[] = [];
  let skipped = 0;
  for (const item of list) {
    const e = (item ?? {}) as Record<string, unknown>;
    let kind: string | undefined;
    let name: string | undefined;
    let element: string | undefined;
    if (typeof e.component === "string") [kind, name] = e.component.split(":", 2);
    else if (e.component && typeof e.component === "object") {
      const c = e.component as Record<string, unknown>;
      kind = typeof c.kind === "string" ? c.kind : undefined;
      name = typeof c.name === "string" ? c.name : undefined;
      element = ident(c.element, 80);
    }
    const at = iso(e.at);
    const first = iso(e.firstSeen) ?? at;
    const last = iso(e.lastSeen) ?? at ?? first;
    const count = typeof e.count === "number" && Number.isInteger(e.count) && e.count > 0 ? e.count : 1;
    if (!kind || !KINDS.has(kind) || !ident(name, 120) || !first || !last) {
      skipped++;
      continue;
    }
    if (since && last < since.toISOString()) continue;
    const signature = classifyError(
      typeof e.message === "string" ? e.message : undefined,
      vocab,
      typeof e.exceptionType === "string" ? e.exceptionType : undefined,
    );
    const ev = event(
      "imported",
      { kind: kind as FailingComponent["kind"], name: name!, ...(element ? { element } : {}) },
      [],
      signature,
      first,
    );
    events.push({ ...ev, count, lastSeen: last });
  }
  return { events, skipped };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

/** Group events with the same source, component and signature. */
export function groupIncidents(events: IncidentEvent[]): Incident[] {
  const groups = new Map<string, Incident>();
  for (const e of events) {
    const s = e.signature;
    const k = JSON.stringify([
      e.source,
      e.component.kind,
      key(e.component.name),
      e.component.element ?? "",
      s.category,
      s.statusCode ?? "",
      s.exceptionType ?? "",
      s.validationRule ?? "",
      s.fields,
    ]);
    const g = groups.get(k);
    if (!g) {
      const id = createHash("sha256").update(k).digest("hex").slice(0, 8);
      groups.set(k, { ...e, via: [...e.via], id });
      continue;
    }
    g.count += e.count;
    if (e.firstSeen < g.firstSeen) g.firstSeen = e.firstSeen;
    if (e.lastSeen > g.lastSeen) g.lastSeen = e.lastSeen;
    for (const v of e.via) {
      if (!g.via.some((x) => x.kind === v.kind && key(x.name) === key(v.name))) g.via.push(v);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}

export interface CollectOptions {
  model: OrgModel;
  vocab: ErrorVocabulary;
  since: Date;
  until?: Date;
  /** Org to read errors from; optional when errors are imported. */
  org?: string;
  runner?: SfRunner;
  /** Org sources to read (default: all). */
  sources?: Exclude<IncidentSource, "imported">[];
  /** Errors imported from a file. */
  imported?: { raw: unknown; file: string };
}

const COLLECTORS: Record<Exclude<IncidentSource, "imported">, (ctx: Ctx) => IncidentEvent[]> = {
  flow: flowErrors,
  apex: apexErrors,
  "async-apex": asyncApexErrors,
  agent: agentErrors,
};

export function collectIncidents(opts: CollectOptions): IncidentCollection {
  const until = opts.until ?? new Date();
  const sources: SourceStatus[] = [];
  const events: IncidentEvent[] = [];
  let label: string | undefined;
  if (opts.org) {
    const org = assertSafeOrg(opts.org);
    const run = opts.runner ?? createSfRunner({ timeoutMs: 300_000 });
    let alias: unknown;
    try {
      alias = (run(["org", "display", "--target-org", org]) as { alias?: unknown } | undefined)?.alias;
    } catch (err) {
      throw new SfError(`Could not use org "${orgLabel(org)}": ${clip(redactEmails((err as Error).message))}`);
    }
    label = orgLabel(org, alias);
    const ctx: Ctx = { run, org, since: opts.since, vocab: opts.vocab, model: opts.model };
    for (const source of opts.sources ?? (Object.keys(COLLECTORS) as Exclude<IncidentSource, "imported">[])) {
      try {
        const found = COLLECTORS[source](ctx).filter((e) => e.lastSeen <= until.toISOString());
        events.push(...found);
        sources.push({ source, label: SOURCE_LABEL[source], status: "ok", events: found.length });
      } catch (err) {
        const unavailable = err instanceof Unavailable;
        sources.push({
          source,
          label: SOURCE_LABEL[source],
          status: unavailable ? "unavailable" : "error",
          events: 0,
          note: clip(redactEmails((err as Error).message)),
        });
      }
    }
  }
  if (opts.imported) {
    const { events: found, skipped } = importErrors(opts.imported.raw, opts.vocab, opts.since);
    events.push(...found);
    sources.push({
      source: "imported",
      label: SOURCE_LABEL.imported,
      status: "ok",
      events: found.reduce((n, e) => n + e.count, 0),
      ...(skipped
        ? { note: `${skipped} entr${skipped === 1 ? "y" : "ies"} without a known component kind, name or time skipped` }
        : {}),
    });
  }
  return {
    ...(label ? { org: label } : {}),
    since: opts.since.toISOString(),
    until: until.toISOString(),
    sources,
    incidents: groupIncidents(events),
  };
}

/**
 * When each component last changed in the org (read-only): Apex classes and triggers, flows and
 * validation rules. Keys are `orgDateKey` values ("apexclass:opportunitycloser").
 */
export function componentDatesInOrg(
  org: string,
  components: { type: string; name: string }[],
  runner?: SfRunner,
): { dates: Map<string, string>; errors: string[] } {
  const run = runner ?? createSfRunner();
  const target = assertSafeOrg(org);
  const dates = new Map<string, string>();
  const errors: string[] = [];
  const names = (type: string) =>
    [...new Set(components.filter((c) => c.type === type).map((c) => c.name))].filter((n) =>
      /^[A-Za-z][A-Za-z0-9_.]*$/.test(n),
    );
  const list = (vals: string[]) => vals.map((v) => `'${v}'`).join(", ");
  const attempt = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${label}: ${clip(redactEmails((err as Error).message))}`);
    }
  };
  for (const [type, sobject] of [
    ["ApexClass", "ApexClass"],
    ["ApexTrigger", "ApexTrigger"],
  ] as const) {
    const n = names(type).filter((x) => !x.includes("."));
    if (!n.length) continue;
    attempt(type, () => {
      for (const r of query(
        run,
        target,
        `SELECT Name, LastModifiedDate FROM ${sobject} WHERE NamespacePrefix = null AND Name IN (${list(n)})`,
      )) {
        const at = iso(r.LastModifiedDate);
        if (typeof r.Name === "string" && at) dates.set(`${type.toLowerCase()}:${key(r.Name)}`, at);
      }
    });
  }
  const flows = names("Flow").filter((x) => !x.includes("."));
  if (flows.length) {
    attempt("Flow", () => {
      for (const r of query(
        run,
        target,
        `SELECT ApiName, LastModifiedDate FROM FlowDefinitionView WHERE ApiName IN (${list(flows)})`,
      )) {
        const at = iso(r.LastModifiedDate);
        if (typeof r.ApiName === "string" && at) dates.set(`flow:${key(r.ApiName)}`, at);
      }
    });
  }
  const rules = names("ValidationRule");
  if (rules.length) {
    attempt("ValidationRule", () => {
      const byName = rules.map((r) => r.split(".")).filter((p) => p.length === 2);
      const rows = query(
        run,
        target,
        `SELECT ValidationName, EntityDefinition.QualifiedApiName, LastModifiedDate FROM ValidationRule WHERE ValidationName IN (${list(byName.map((p) => p[1]!))})`,
        true,
      );
      for (const r of rows) {
        const object = field(r, "EntityDefinition.QualifiedApiName");
        const at = iso(r.LastModifiedDate);
        if (typeof r.ValidationName === "string" && typeof object === "string" && at) {
          dates.set(`validationrule:${key(`${object}.${r.ValidationName}`)}`, at);
        }
      }
    });
  }
  return { dates, errors };
}
