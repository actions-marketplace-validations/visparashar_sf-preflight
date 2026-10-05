// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writersOf } from "../graph.js";
import { analyzeApexAst } from "../parsers/apexAst.js";
import type {
  AnalysisResult,
  AutomationRef,
  CascadeNode,
  FlowDef,
  FlowFilter,
  OrgModel,
  SaveEvent,
  TestKind,
  ValidationRuleDef,
} from "../types.js";
import { key, uniq } from "../util.js";
import { factorySource } from "./factory.js";
import { fieldDef, isSettable, relationshipField, solverContext } from "./schema.js";
import {
  type Assignment,
  achieve,
  assign,
  type Expr,
  emptyAssignment,
  evaluate,
  type FValue,
  parseFormula,
  solveRules,
} from "./solver.js";

/**
 * Generate Apex tests for what a change touches (milestone M4).
 *
 * Tests check behaviour that should hold for any correct implementation — no governor-limit
 * failures at bulk volume, no recursion blow-ups, automation not applied twice, validation
 * errors not swallowed — rather than business rules, which only the team knows. Records come
 * from a runtime data factory that reads the org's schema, and the validation-rule solver picks
 * field values so test data passes the project's rules.
 */

export interface GeneratedTest {
  method: string;
  kind: TestKind;
  title: string;
  covers: string[];
  /** Caveats, e.g. a validation rule the generator couldn't satisfy. */
  notes: string[];
}

export interface SkippedTest {
  kind: TestKind;
  title: string;
  reason: string;
}

export interface GeneratedFile {
  /** Relative to the output directory, e.g. "classes/PreflightChangeTest.cls". */
  path: string;
  content: string;
}

export interface TestGenResult {
  className: string;
  factoryName: string;
  apiVersion: string;
  bulkSize: number;
  files: GeneratedFile[];
  tests: GeneratedTest[];
  skipped: SkippedTest[];
}

export interface TestGenOptions {
  /** Prefix for generated class names (default "Preflight"). */
  prefix?: string;
  /** Test class name (default `<prefix>ChangeTest`). */
  className?: string;
  /** Records per bulk test (default 200, Salesforce's trigger batch size). */
  bulkSize?: number;
  /** Apex API version for -meta.xml files (default: sfdx-project.json sourceApiVersion, else 62.0). */
  apiVersion?: string;
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const UNSUPPORTED_OBJECTS = new Set([
  "user",
  "group",
  "profile",
  "permissionset",
  "permissionsetassignment",
  "recordtype",
]);

export function apexString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n")}'`;
}

const pascal = (s: string) =>
  s
    .replace(/__c$/i, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");

const describeVia = (v: AutomationRef) =>
  v.kind === "Flow"
    ? `flow ${v.name}`
    : v.kind === "ApexTrigger"
      ? `trigger ${v.name}`
      : v.kind === "ApexClass"
        ? `class ${v.name}`
        : v.kind === "RollUpSummary"
          ? `roll-up ${v.name}`
          : v.name;

function apiVersionOf(projectDir: string): string {
  try {
    const file = path.join(projectDir, "sfdx-project.json");
    if (existsSync(file)) {
      const v = (JSON.parse(readFileSync(file, "utf8")) as { sourceApiVersion?: string }).sourceApiVersion;
      if (v && /^\d+\.\d$/.test(v)) return v;
    }
  } catch {
    // fall through
  }
  return "62.0";
}

export function metaXml(apiVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${apiVersion}</apiVersion>
    <status>Active</status>
</ApexClass>
`;
}

/** Fields mentioned in a formula expression (simple names only, lower-case). */
function fieldsOf(e: Expr, out = new Set<string>()): Set<string> {
  if (e.t === "field") out.add(key(e.name));
  else if (e.t === "call") for (const a of e.args) fieldsOf(a, out);
  else if (e.t === "bin") {
    fieldsOf(e.left, out);
    fieldsOf(e.right, out);
  } else if (e.t === "not" || e.t === "neg") fieldsOf(e.arg, out);
  return out;
}

function andParts(e: Expr): Expr[] {
  if (e.t === "call" && e.name === "AND") return e.args.flatMap(andParts);
  if (e.t === "bin" && e.op === "&&") return [...andParts(e.left), ...andParts(e.right)];
  return [e];
}

/** Value that satisfies one flow entry condition, or undefined when we can't tell. */
function filterValue(f: FlowFilter, event: SaveEvent): FValue | undefined {
  const v = f.value;
  const num = v?.kind === "number" ? Number(v.value) : undefined;
  const bool = v?.kind === "boolean" ? v.value.toLowerCase() === "true" : undefined;
  switch (f.operator) {
    case "EqualTo":
      if (v?.kind === "string") return { kind: "lit", value: v.value };
      if (num !== undefined && !Number.isNaN(num)) return { kind: "lit", value: num };
      if (bool !== undefined) return { kind: "lit", value: bool };
      return undefined;
    case "NotEqualTo":
      if (v?.kind === "string") return { kind: "not", value: v.value };
      if (num !== undefined && !Number.isNaN(num)) return { kind: "lit", value: num + 1 };
      if (bool !== undefined) return { kind: "lit", value: !bool };
      return undefined;
    case "IsNull":
      return bool === undefined ? undefined : bool ? { kind: "null" } : { kind: "any" };
    case "IsChanged":
      return bool === true && event === "update" ? { kind: "any" } : undefined;
    case "GreaterThan":
      return num === undefined ? undefined : { kind: "lit", value: num + 1 };
    case "LessThan":
      return num === undefined ? undefined : { kind: "lit", value: num - 1 };
    case "GreaterThanOrEqualTo":
    case "LessThanOrEqualTo":
      return num === undefined ? undefined : { kind: "lit", value: num };
    case "StartsWith":
    case "EndsWith":
    case "Contains":
      return v?.kind === "string" ? { kind: "lit", value: v.value } : undefined;
    default:
      return undefined;
  }
}

/** Field values that meet a record-triggered flow's entry criteria; undefined when unknown. */
export function flowIntent(model: OrgModel, flow: FlowDef, event: SaveEvent): [string, FValue][] | undefined {
  const t = flow.trigger;
  if (!t || t.filterFormula) return undefined;
  if (!t.filters.length) return [];
  const logic = t.filterLogic;
  const usable =
    logic === undefined || logic === "and" || t.filters.length === 1
      ? t.filters
      : logic === "or"
        ? t.filters.slice(0, 1)
        : undefined;
  if (!usable) return undefined;
  const out: [string, FValue][] = [];
  for (const f of usable) {
    const v = filterValue(f, event);
    if (!v || !isSettable(model, t.object, f.field)) return undefined;
    out.push([f.field, v]);
  }
  return out;
}

// ----------------------------------------------------------------------------------------

class TestClassBuilder {
  readonly methods: string[] = [];
  readonly tests: GeneratedTest[] = [];
  readonly skipped: SkippedTest[] = [];
  private readonly names = new Set<string>();
  needsSaveAssert = false;
  needsDeleteAssert = false;

  constructor(
    readonly model: OrgModel,
    readonly factory: string,
  ) {}

  uniqueName(base: string): string {
    let name = base.slice(0, 60);
    for (let i = 2; this.names.has(key(name)); i++) name = `${base.slice(0, 57)}${i}`;
    this.names.add(key(name));
    return name;
  }

  value(v: FValue): string {
    switch (v.kind) {
      case "null":
        return "null";
      case "any":
        return `${this.factory}.ANY_VALUE`;
      case "not":
        return `${this.factory}.notValue(${apexString(v.value)})`;
      case "lit":
        return typeof v.value === "string" ? apexString(v.value) : String(v.value);
    }
  }

  map(a: Assignment, indent = "            ", override?: Map<string, FValue>): string {
    const entries = [...a.values].map(([k, v]) => [a.names.get(k) ?? k, override?.get(k) ?? v] as const);
    if (!entries.length) return "null";
    const body = entries.map(([f, v]) => `${indent}    ${apexString(f)} => ${this.value(v)}`).join(",\n");
    return `new Map<String, Object>{\n${body}\n${indent}}`;
  }

  rules(object: string): ValidationRuleDef[] {
    return this.model.validationRules.filter((v) => v.active && key(v.object) === key(object));
  }

  /** Solve the object's validation rules on top of `intent`; notes describe unsolved rules. */
  solve(object: string, event: "insert" | "update", intent: Assignment, current?: Assignment) {
    const result = solveRules(
      this.rules(object).map((r) => ({ name: r.name, formula: r.formula })),
      solverContext(this.model, object, event, current?.values),
      intent,
    );
    const notes = result.unsolved.map(
      (u) =>
        `May be blocked by validation rule ${object}.${u.name} on ${event} (${u.reason}); adjust the values below.`,
    );
    return { assignment: result.assignment, notes };
  }

  add(test: GeneratedTest, lines: string[]): void {
    const comment = [`// ${test.title}`, ...test.notes.map((n) => `// NOTE: ${n}`)].map((l) => `    ${l}`);
    this.methods.push(
      [
        ...comment,
        "    @IsTest",
        `    static void ${test.method}() {`,
        ...lines.map((l) => (l ? `        ${l}` : "")),
        "    }",
      ].join("\n"),
    );
    this.tests.push(test);
  }

  skip(kind: TestKind, title: string, reason: string): void {
    this.skipped.push({ kind, title, reason });
  }
}

export function generateTests(model: OrgModel, result: AnalysisResult, opts: TestGenOptions = {}): TestGenResult {
  const prefix = opts.prefix ?? "Preflight";
  const factoryName = `${prefix}DataFactory`;
  const className = opts.className ?? `${prefix}ChangeTest`;
  for (const n of [factoryName, className]) {
    if (!IDENT.test(n) || n.length > 40 || n.includes("__")) throw new Error(`Invalid Apex class name: ${n}`);
  }
  const bulkSize = opts.bulkSize ?? 200;
  if (!Number.isInteger(bulkSize) || bulkSize < 1 || bulkSize > 10000) throw new Error("bulkSize must be 1–10000");
  const apiVersion = opts.apiVersion ?? apiVersionOf(model.projectDir);
  const F = factoryName;
  const b = new TestClassBuilder(model, F);

  /** `Factory.touch(...)` line, or nothing when there is nothing to set. */
  const touchLine = (target: string, a: Assignment) =>
    a.values.size ? [`${F}.touch(${target}, ${b.map(a, "        ")});`] : [];

  const changedFields = (object: string) =>
    result.changes
      .filter(
        (c) =>
          c.component.type === "CustomField" &&
          c.changeType !== "deleted" &&
          key(c.component.object ?? "") === key(object) &&
          isSettable(model, object, c.component.name.split(".")[1] ?? ""),
      )
      .map((c) => c.component.name.split(".")[1]!);

  const flowsOn = (object: string, event: SaveEvent) =>
    [...model.flows.values()].filter(
      (f) => f.active && f.trigger && key(f.trigger.object) === key(object) && f.trigger.events.includes(event),
    );

  /** Changed fields plus values that meet the entry criteria of the object's flows. */
  const intentFor = (object: string, event: "insert" | "update") => {
    let a = emptyAssignment();
    const notes: string[] = [];
    for (const f of changedFields(object)) a = assign(a, f, { kind: "any" });
    for (const flow of flowsOn(object, event)) {
      const values = flowIntent(model, flow, event);
      if (!values) {
        notes.push(`Entry criteria of flow ${flow.name} aren't modelled; it may not run in this test.`);
        continue;
      }
      if (values.some(([f, v]) => a.values.has(key(f)) && JSON.stringify(a.values.get(key(f))) !== JSON.stringify(v))) {
        notes.push(`Flow ${flow.name}'s entry criteria conflict with another flow's; it may not run in this test.`);
        continue;
      }
      for (const [f, v] of values) if (!a.values.has(key(f))) a = assign(a, f, v);
    }
    return { a, notes };
  };

  /**
   * Lookups from `object` to the parents its save cascades into (roll-ups, automation that
   * updates the parent). Bulk records point at one shared parent so that part of the cascade runs.
   */
  const parentLinks = (object: string, event: SaveEvent) => {
    let a = emptyAssignment();
    const notes: string[] = [];
    for (const root of result.cascade.filter((n) => key(n.object) === key(object) && n.event === event)) {
      for (const child of root.children) {
        if (key(child.object) === key(object) || !child.via) continue;
        const field = relationshipField(model, object, child.object);
        if (!field || a.values.has(key(field)) || !isSettable(model, object, field)) continue;
        a = assign(a, field, { kind: "any" });
        notes.push(`The records share one ${child.object} through ${field}, so ${describeVia(child.via)} runs on it.`);
      }
    }
    return { a, notes };
  };
  const withLinks = (a: Assignment, links: Assignment) => {
    let out = a;
    for (const [k, v] of links.values) if (!out.values.has(k)) out = assign(out, links.names.get(k) ?? k, v);
    return out;
  };

  const coversOf = (object: string, event: SaveEvent) =>
    uniq(
      (result.saveProcedures.find((p) => key(p.object) === key(object) && p.event === event)?.steps ?? []).map(
        (s) => s.automation.name,
      ),
    );

  // --------------------------------------------------------------------------------------
  // 1. Bulk tests per root (object, event)
  // --------------------------------------------------------------------------------------
  const roots = uniq(result.cascade.map((n) => `${n.object}|${n.event}`)).map((s) => {
    const [object, event] = s.split("|") as [string, SaveEvent];
    return { object, event };
  });
  for (const { object, event } of roots) {
    const title = `Bulk ${event} of ${bulkSize} ${object} records`;
    if (!IDENT.test(object) || UNSUPPORTED_OBJECTS.has(key(object))) {
      b.skip("bulk", title, `${object} records can't be created by the generic data factory.`);
      continue;
    }
    if (event === "undelete") {
      b.skip("bulk", title, "Undelete tests aren't generated yet.");
      continue;
    }
    const covers = coversOf(object, event);
    const links = parentLinks(object, event);
    const base = b.solve(object, "insert", links.a);
    if (event === "delete") {
      b.needsDeleteAssert = true;
      const notes = [...links.notes, ...base.notes];
      b.add({ method: b.uniqueName(`bulkDelete${pascal(object)}`), kind: "bulk", title, covers, notes }, [
        `List<SObject> records = ${F}.create(${apexString(object)}, RECORD_COUNT, ${b.map(base.assignment, "        ")});`,
        "Test.startTest();",
        "List<Database.DeleteResult> results = Database.delete(records, false);",
        "Test.stopTest();",
        `assertDeleted(results, ${apexString(`bulk delete of ${object}`)});`,
      ]);
      continue;
    }
    const intent = intentFor(object, event);
    b.needsSaveAssert = true;
    if (event === "insert") {
      const solved = b.solve(object, "insert", withLinks(intent.a, links.a));
      b.add(
        {
          method: b.uniqueName(`bulkInsert${pascal(object)}`),
          kind: "bulk",
          title,
          covers,
          notes: [...links.notes, ...intent.notes, ...solved.notes],
        },
        [
          `List<SObject> records = ${F}.build(${apexString(object)}, RECORD_COUNT, ${b.map(solved.assignment, "        ")});`,
          "Test.startTest();",
          "List<Database.SaveResult> results = Database.insert(records, false);",
          "Test.stopTest();",
          `assertSaved(results, ${apexString(`bulk insert of ${object}`)});`,
        ],
      );
    } else {
      const solved = b.solve(object, "update", intent.a, base.assignment);
      b.add(
        {
          method: b.uniqueName(`bulkUpdate${pascal(object)}`),
          kind: "bulk",
          title,
          covers,
          notes: [...links.notes, ...base.notes, ...intent.notes, ...solved.notes],
        },
        [
          `List<SObject> records = ${F}.create(${apexString(object)}, RECORD_COUNT, ${b.map(base.assignment, "        ")});`,
          ...touchLine("records", solved.assignment),
          "Test.startTest();",
          "List<Database.SaveResult> results = Database.update(records, false);",
          "Test.stopTest();",
          `assertSaved(results, ${apexString(`bulk update of ${object}`)});`,
        ],
      );
    }
  }

  // --------------------------------------------------------------------------------------
  // 2. Recursion tests per cycle across objects
  // --------------------------------------------------------------------------------------
  const loops: CascadeNode[][] = [];
  const seen = new Set<string>();
  const dfs = (n: CascadeNode, pathSoFar: CascadeNode[]) => {
    const p = [...pathSoFar, n];
    if (n.cycle) {
      const j = pathSoFar.findIndex((x) => key(x.object) === key(n.object));
      if (j >= 0) {
        const loop = p.slice(j);
        const sig = loop
          .slice(1)
          .map((x) => `${key(x.object)}|${x.via?.name ?? ""}`)
          .sort()
          .join(">");
        if (!seen.has(sig)) {
          seen.add(sig);
          loops.push(loop);
        }
      }
      return;
    }
    for (const c of n.children) dfs(c, p);
  };
  for (const r of result.cascade) dfs(r, []);

  for (const loop of loops) {
    const start = loop[0]!;
    const hop = loop[1]!;
    const via = hop.via!;
    const label = loop.map((n) => n.object).join(" -> ");
    const title = `Update ${bulkSize} ${start.object} records along the ${label} cycle`;
    if (loop.length === 2) {
      b.skip(
        "recursion",
        title,
        `Covered by the bulk ${start.event} test of ${start.object}, which meets ${describeVia(via)}'s entry criteria.`,
      );
      continue;
    }
    if (
      start.event !== "update" ||
      UNSUPPORTED_OBJECTS.has(key(start.object)) ||
      UNSUPPORTED_OBJECTS.has(key(hop.object))
    ) {
      b.skip("recursion", title, "Only update cycles between createable objects are generated.");
      continue;
    }
    // How records of the next object relate to the start object.
    let children: string | undefined; // field on hop.object pointing at start.object
    let parents: string | undefined; // field on start.object pointing at hop.object
    let intent = emptyAssignment();
    const notes: string[] = [];
    if (via.kind === "Flow") {
      const flow = model.flows.get(key(via.name));
      children = flow?.writes.find((w) => key(w.object) === key(hop.object) && w.linkField)?.linkField;
      const values = flow ? flowIntent(model, flow, "update") : undefined;
      if (values) for (const [f, v] of values) intent = assign(intent, f, v);
      else notes.push(`Entry criteria of flow ${via.name} aren't modelled; it may not run in this test.`);
    } else if (via.kind === "RollUpSummary") {
      const [parentObject, fieldName] = via.name.split(".");
      const summary = fieldDef(model, parentObject ?? "", fieldName ?? "")?.summary;
      parents = summary?.relationshipField;
      const summarized = summary?.summarizedField?.split(".")[1];
      if (summarized && isSettable(model, start.object, summarized))
        intent = assign(intent, summarized, { kind: "any" });
      notes.push("Roll-up summaries only update the parent when the summarized value changes.");
    }
    children ??= parents ? undefined : relationshipField(model, hop.object, start.object);
    parents ??= children ? undefined : relationshipField(model, start.object, hop.object);
    if (!children && !parents) {
      b.skip("recursion", title, `Couldn't tell how ${hop.object} records relate to ${start.object} records.`);
      continue;
    }
    const linkOn = children ? hop.object : start.object;
    const link = (children ?? parents)!;
    const linkObject = children ? hop.object : start.object;
    const startBase = b.solve(
      start.object,
      "insert",
      children ? emptyAssignment() : assign(emptyAssignment(), link, { kind: "any" }),
    );
    const hopBase = b.solve(
      hop.object,
      "insert",
      children ? assign(emptyAssignment(), link, { kind: "any" }) : emptyAssignment(),
    );
    const update = b.solve(start.object, "update", intent, startBase.assignment);
    // The link is set in code after building, so build it blank (avoids creating a shared parent).
    const blankLink = new Map<string, FValue>([[key(link), { kind: "null" }]]);
    const mapOf = (object: string, a: Assignment) =>
      b.map(a, "        ", key(object) === key(linkOn) ? blankLink : undefined);
    const lines = children
      ? [
          `List<SObject> records = ${F}.create(${apexString(start.object)}, RECORD_COUNT, ${mapOf(start.object, startBase.assignment)});`,
          `List<SObject> related = ${F}.build(${apexString(hop.object)}, RECORD_COUNT, ${mapOf(hop.object, hopBase.assignment)});`,
          "for (Integer i = 0; i < RECORD_COUNT; i++) {",
          `    related[i].put(${apexString(link)}, records[i].Id);`,
          "}",
          `${F}.insertRecords(related);`,
        ]
      : [
          `List<SObject> related = ${F}.create(${apexString(hop.object)}, RECORD_COUNT, ${mapOf(hop.object, hopBase.assignment)});`,
          `List<SObject> records = ${F}.build(${apexString(start.object)}, RECORD_COUNT, ${mapOf(start.object, startBase.assignment)});`,
          "for (Integer i = 0; i < RECORD_COUNT; i++) {",
          `    records[i].put(${apexString(link)}, related[i].Id);`,
          "}",
          `${F}.insertRecords(records);`,
        ];
    b.needsSaveAssert = true;
    b.add(
      {
        method: b.uniqueName(
          `recursion${loop
            .slice(0, -1)
            .map((n) => pascal(n.object))
            .join("")}`,
        ),
        kind: "recursion",
        title,
        covers: uniq(loop.slice(1).map((n) => n.via?.name ?? "")).filter(Boolean),
        notes: [
          `Cycle: ${loop.map((n, i) => (i === 0 ? n.object : `${n.object} via ${describeVia(n.via!)}`)).join(" -> ")}. Fails on recursion or governor limits.`,
          ...notes,
          ...startBase.notes,
          ...hopBase.notes,
          ...update.notes,
        ],
      },
      [
        ...lines,
        ...touchLine("records", update.assignment),
        "Test.startTest();",
        "List<Database.SaveResult> results = Database.update(records, false);",
        "Test.stopTest();",
        `assertSaved(results, ${apexString(`update of ${start.object} along the ${label} cycle (${linkObject}.${link})`)});`,
      ],
    );
  }

  // --------------------------------------------------------------------------------------
  // 3. Idempotency tests for after-save flows that update their own record
  // --------------------------------------------------------------------------------------
  const selfUpdating = uniq(
    result.saveProcedures.flatMap((p) =>
      p.steps
        .filter((s) => s.phase === "after-flow" && s.writes.some((w) => w.selfUpdate))
        .map((s) => s.automation.name),
    ),
  );
  for (const name of selfUpdating) {
    const flow = model.flows.get(key(name));
    if (!flow?.trigger) continue;
    const object = flow.trigger.object;
    const title = `Save the same ${object} twice: flow ${flow.name} must not apply twice`;
    if (!flow.trigger.events.includes("update")) {
      b.skip("idempotency", title, "The flow only runs on create.");
      continue;
    }
    const created = flow.writes.filter((w) => w.op === "insert" && w.linkField && IDENT.test(w.object));
    if (!created.length) {
      b.skip(
        "idempotency",
        title,
        `Flow ${flow.name} only sets fields on its own record, so saving twice can't double-apply it.`,
      );
      continue;
    }
    const values = flowIntent(model, flow, "update");
    if (!values) {
      b.skip("idempotency", title, `Entry criteria of flow ${flow.name} aren't modelled.`);
      continue;
    }
    let intent = emptyAssignment();
    for (const [f, v] of values) intent = assign(intent, f, v);
    const base = b.solve(object, "insert", emptyAssignment());
    const update = b.solve(object, "update", intent, base.assignment);
    const counts = created.map((w, i) => ({
      v: `created${i + 1}`,
      q: `[SELECT COUNT() FROM ${w.object} WHERE ${w.linkField} = :recordId]`,
      object: w.object,
    }));
    b.add(
      {
        method: b.uniqueName(`idempotent${pascal(flow.name)}`),
        kind: "idempotency",
        title,
        covers: [flow.name],
        notes: [
          `Flow ${flow.name} creates ${uniq(created.map((w) => w.object)).join(", ")} records and updates its own ${object}.`,
          ...base.notes,
          ...update.notes,
        ],
      },
      [
        `SObject record = ${F}.createOne(${apexString(object)}, ${b.map(base.assignment, "        ")});`,
        "Id recordId = record.Id;",
        ...touchLine("new List<SObject>{ record }", update.assignment),
        "update record;",
        ...counts.map((c) => `Integer ${c.v}First = ${c.q};`),
        "Test.startTest();",
        "update record.getSObjectType().newSObject(recordId); // save again without changes",
        "Test.stopTest();",
        ...counts.flatMap((c) => [
          `Integer ${c.v}Second = ${c.q};`,
          `System.assertEquals(${c.v}First, ${c.v}Second, 'Saving ${object} again without changes created ' + (${c.v}Second - ${c.v}First) + ' more ${c.object} record(s): flow ${flow.name} runs on every save that meets its entry criteria. Consider "Only when a record is updated to meet the condition requirements".');`,
        ]),
      ],
    );
  }

  // --------------------------------------------------------------------------------------
  // 4. Validation errors must surface from invocable (agent) actions
  // --------------------------------------------------------------------------------------
  const touchedRuleObjects = new Set<string>();
  for (const c of result.changes) {
    if (c.component.type === "ValidationRule" && c.component.object) touchedRuleObjects.add(key(c.component.object));
  }
  for (const r of result.references) {
    if (r.from.kind === "ValidationRule") touchedRuleObjects.add(key(r.to.split(".")[0] ?? ""));
  }
  const candidates = new Map<string, { cls: string; object: string }>();
  const addCandidate = (cls: string, object: string) => candidates.set(`${key(cls)}|${key(object)}`, { cls, object });
  for (const root of result.cascade) {
    if (root.via?.kind === "ApexClass") addCandidate(root.via.name, root.object);
  }
  for (const o of touchedRuleObjects) {
    const object = model.objects.get(o)?.name ?? o;
    for (const w of writersOf(model, object))
      if (w.automation.kind === "ApexClass") addCandidate(w.automation.name, object);
  }
  for (const { cls: clsName, object } of candidates.values()) {
    const cls = model.classes.get(key(clsName));
    const method = cls?.methods?.find((m) => m.invocable);
    if (!cls || cls.isTest || !method) continue;
    const titleBase = `${cls.name}.${method.name} must surface validation errors on ${object}`;
    const param = (method.params ?? [])[0]?.replace(/\s/g, "");
    const listOf = param && /^List<(\w+)>$/i.exec(param)?.[1];
    if (
      !method.isStatic ||
      method.params?.length !== 1 ||
      !listOf ||
      !(key(listOf) === "id" || key(listOf) === key(object))
    ) {
      b.skip(
        "validation-collision",
        titleBase,
        `Invocable parameter ${param ?? "(none)"} isn't supported yet (List<Id> or List<${object}> only).`,
      );
      continue;
    }
    const written = uniq(
      (cls.fieldWrites ?? [])
        .filter((f) => key(f.split(".")[0] ?? "") === key(object) && f.split(".").length === 2)
        .map((f) => f.split(".")[1]!),
    );
    if (!written.length) {
      b.skip("validation-collision", titleBase, `Couldn't tell which ${object} fields ${cls.name} changes.`);
      continue;
    }
    const writtenKeys = new Set(written.map(key));
    for (const rule of b.rules(object).filter((r) => r.fieldRefs.some((f) => writtenKeys.has(key(f))))) {
      const title = `${titleBase} (validation rule ${rule.name})`;
      let expr: Expr;
      try {
        expr = parseFormula(rule.formula);
      } catch {
        b.skip("validation-collision", title, "Validation rule formula not understood.");
        continue;
      }
      const parts = andParts(expr);
      const actionParts = parts.filter((p) => {
        const fs = [...fieldsOf(p)];
        return fs.length > 0 && fs.every((f) => writtenKeys.has(f));
      });
      const trapParts = parts.filter((p) => ![...fieldsOf(p)].some((f) => writtenKeys.has(f)));
      if (!actionParts.length || actionParts.length + trapParts.length !== parts.length) {
        b.skip(
          "validation-collision",
          title,
          "The rule mixes fields the action writes and fields it doesn't in one condition.",
        );
        continue;
      }
      const ctx = solverContext(model, object, "insert");
      let trap: Assignment | undefined = emptyAssignment();
      for (const p of trapParts) trap = trap && achieve(p, true, trap, ctx);
      // Pin trap fields explicitly, even when the default already satisfies them.
      for (const f of trapParts.flatMap((p) => [...fieldsOf(p)])) {
        const v = ctx.defaultOf(f);
        if (trap && !trap.values.has(f) && v && isSettable(model, object, f)) {
          trap = assign(trap, fieldDef(model, object, f)?.name ?? f, v);
        }
      }
      const safe = trap && achieve({ t: "call", name: "AND", args: actionParts }, false, trap, ctx);
      if (!safe || evaluate(expr, safe, ctx) !== false) {
        b.skip(
          "validation-collision",
          title,
          "Couldn't set up a record the rule accepts now but blocks after the action.",
        );
        continue;
      }
      const others = b.solve(object, "insert", safe);
      const otherNotes = others.notes.filter((n) => !n.includes(`${object}.${rule.name} `));
      const select = `[SELECT Id, ${written.join(", ")} FROM ${object} WHERE Id = :recordId]`;
      const arg = key(listOf) === "id" ? "new List<Id>{ recordId }" : `new List<${object}>{ (${object}) record }`;
      b.add(
        {
          method: b.uniqueName(`surfacesErrors${pascal(cls.name)}${pascal(rule.name)}`),
          kind: "validation-collision",
          title,
          covers: [cls.name, rule.name],
          notes: [
            `${cls.name}.${method.name} writes ${written.map((f) => `${object}.${f}`).join(", ")}; the record is set up so ${rule.name} can block that write. The action must then raise an error rather than silently leave the record unchanged.`,
            ...otherNotes,
          ],
        },
        [
          `SObject record = ${F}.createOne(${apexString(object)}, ${b.map(others.assignment, "        ")});`,
          "Id recordId = record.Id;",
          `SObject beforeCall = ${select};`,
          "Boolean surfaced = false;",
          "Test.startTest();",
          "try {",
          `    ${cls.name}.${method.name}(${arg});`,
          "} catch (Exception e) {",
          "    surfaced = true;",
          "}",
          "Test.stopTest();",
          `SObject afterCall = ${select};`,
          `Boolean changed = ${written.map((f) => `beforeCall.get(${apexString(f)}) != afterCall.get(${apexString(f)})`).join(" || ")};`,
          `System.assert(surfaced || changed, ${apexString(`${cls.name}.${method.name} neither changed ${object} `)} + recordId + ${apexString(` nor raised an error: a validation failure (${rule.name}) was swallowed.`)});`,
        ],
      );
    }
  }

  // --------------------------------------------------------------------------------------
  // 5. What isn't generated
  // --------------------------------------------------------------------------------------
  for (const f of result.findings.filter((x) => x.rule.startsWith("permission-"))) {
    b.skip(
      "permission-negative",
      f.title,
      "Permission tests depend on who should be allowed to do what; write them with System.runAs using the suggested test.",
    );
  }

  // --------------------------------------------------------------------------------------
  // Assemble
  // --------------------------------------------------------------------------------------
  const files: GeneratedFile[] = [];
  if (b.tests.length) {
    const helpers: string[] = [];
    const assertFor = (type: string, name: string) =>
      [
        `    private static void ${name}(List<Database.${type}> results, String context) {`,
        "        List<String> errors = new List<String>();",
        `        for (Database.${type} result : results) {`,
        "            for (Database.Error error : result.getErrors()) {",
        "                errors.add(error.getStatusCode() + ': ' + error.getMessage());",
        "            }",
        "        }",
        "        System.assert(",
        "            errors.isEmpty(),",
        "            context + ' failed for ' + errors.size() + ' record(s). First error: ' + (errors.isEmpty() ? '' : errors[0])",
        "        );",
        "    }",
      ].join("\n");
    if (b.needsSaveAssert) helpers.push(assertFor("SaveResult", "assertSaved"));
    if (b.needsDeleteAssert) helpers.push(assertFor("DeleteResult", "assertDeleted"));
    const changeList = result.changes
      .map((c) => ` *   ${c.changeType} ${c.component.type} ${c.component.name}`)
      .join("\n");
    const cls = [
      "/**",
      " * Generated by sf-preflight for this change:",
      changeList || " *   (no metadata changes)",
      " *",
      " * These tests check properties any correct implementation should have (no governor-limit",
      " * failures at bulk volume, no runaway recursion, automation not applied twice, validation",
      " * errors not swallowed), not your business rules. Review the NOTE comments before relying",
      " * on a result; regenerate after further changes.",
      " */",
      "@IsTest",
      `private class ${className} {`,
      `    private static final Integer RECORD_COUNT = ${bulkSize};`,
      "",
      b.methods.join("\n\n"),
      "",
      helpers.join("\n\n"),
      "}",
      "",
    ].join("\n");
    files.push(
      { path: `classes/${factoryName}.cls`, content: factorySource(factoryName) },
      { path: `classes/${factoryName}.cls-meta.xml`, content: metaXml(apiVersion) },
      { path: `classes/${className}.cls`, content: cls },
      { path: `classes/${className}.cls-meta.xml`, content: metaXml(apiVersion) },
    );
    for (const f of files.filter((x) => x.path.endsWith(".cls"))) {
      const parsed = analyzeApexAst(f.content, { projectObjects: new Set(model.objects.keys()), kind: "class" });
      if ("errors" in parsed) {
        const e = parsed.errors[0]!;
        throw new Error(
          `Internal error: generated ${f.path} doesn't parse (line ${e.line}: ${e.message}). Please report it.`,
        );
      }
    }
  }

  return { className, factoryName, apiVersion, bulkSize, files, tests: b.tests, skipped: b.skipped };
}
