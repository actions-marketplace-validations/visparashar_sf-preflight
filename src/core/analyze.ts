import type {
  AnalysisResult,
  AutomationRef,
  CascadeNode,
  Change,
  DmlOp,
  Finding,
  LoopIssue,
  OrgModel,
  PermissionContainerDef,
  Reference,
  SaveEvent,
  SaveProcedure,
  Severity,
  SuggestedTest,
} from "./types.js";
import { saveProcedure } from "./orderOfExecution.js";
import { callersOfClass, callersOfFlow, classWrites, flowWrites, knownClassRefs, writersOf } from "./graph.js";
import { parsePermissionContainer } from "./parsers/permissions.js";
import { key, uniq, uniqBy } from "./util.js";

export interface AnalyzeOptions {
  model: OrgModel;
  changes: Change[];
  ignoredFiles?: string[];
  base?: string;
  head?: string;
  /** Max cascade depth (default 4). */
  maxDepth?: number;
  /** Read a project-relative file at the base ref, to diff permission sets. */
  readBase?: (file: string) => string | undefined;
}

interface Root {
  object: string;
  event: SaveEvent;
  via: AutomationRef;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const AUTOMATION_KINDS = new Set(["Flow", "ApexTrigger", "ApexClass", "RollUpSummary"]);
const SENSITIVE_USER_PERMS = new Set(
  ["ModifyAllData", "ViewAllData", "ManageUsers", "AuthorApex", "CustomizeApplication", "ModifyMetadata", "ManageProfilesPermissionsets"].map(
    (p) => p.toLowerCase(),
  ),
);
const MAX_NODES = 400;

export function opToEvent(op: DmlOp): SaveEvent {
  if (op === "upsert") return "update";
  return op;
}

const describe = (a: AutomationRef) => {
  switch (a.kind) {
    case "Flow":
      return `flow ${a.name}`;
    case "ApexTrigger":
      return `trigger ${a.name}`;
    case "ApexClass":
      return `class ${a.name}`;
    case "ValidationRule":
      return `validation rule ${a.name}`;
    case "RollUpSummary":
      return `roll-up ${a.name}`;
    default:
      return a.name;
  }
};

export function analyze(opts: AnalyzeOptions): AnalysisResult {
  const { model, changes } = opts;
  const maxDepth = opts.maxDepth ?? 4;
  const roots: Root[] = [];
  const references: Reference[] = [];
  const findings: Finding[] = [];
  const tests: SuggestedTest[] = [];
  const changedFiles = new Set(changes.map((c) => c.component.file));
  const changedAutomation = new Set<string>(); // "Kind:name" lower

  const addFinding = (f: Finding) => findings.push(f);
  const changeRef = (c: Change): AutomationRef => ({ kind: "Change", name: c.component.name, file: c.component.file });

  // ------------------------------------------------------------------------------------
  // 1. Seed roots, references and change-specific findings
  // ------------------------------------------------------------------------------------
  for (const change of changes) {
    const comp = change.component;
    const deleted = change.changeType === "deleted";
    switch (comp.type) {
      case "CustomField": {
        const [object, field] = [comp.object!, comp.name.split(".")[1]!];
        roots.push({ object, event: "update", via: changeRef(change) }, { object, event: "insert", via: changeRef(change) });
        const refs = fieldReferences(model, object, field);
        references.push(...refs);
        const nonPermRefs = refs.filter((r) => r.from.kind !== "PermissionSet" && r.from.kind !== "Profile");
        if (deleted && nonPermRefs.length) {
          addFinding({
            rule: "deleted-still-referenced",
            severity: "high",
            title: `Deleted field ${comp.name} is still referenced`,
            detail: `Referenced by ${nonPermRefs.map((r) => `${r.from.kind} ${r.from.name}`).join(", ")}. The deployment will fail or the references will break.`,
            object,
            files: uniq([comp.file, ...nonPermRefs.map((r) => r.from.file).filter((f): f is string => !!f)]),
          });
        }
        const vrRefs = refs.filter((r) => r.from.kind === "ValidationRule");
        for (const r of vrRefs) {
          const vr = model.validationRules.find((v) => v.name === r.from.name && key(v.object) === key(object));
          if (!vr?.active) continue;
          addFinding({
            rule: "field-used-by-validation-rule",
            severity: "medium",
            title: `${comp.name} is checked by validation rule ${vr.name}`,
            detail: `Every automation that saves ${object} must satisfy: ${vr.formula.replace(/\s+/g, " ").trim()}`,
            object,
            files: [comp.file, vr.file],
          });
          tests.push({
            kind: "boundary",
            object,
            description: `Save ${object} with ${field} blank and at boundary values; assert ${vr.name} fires only when intended.`,
            covers: [comp.name, vr.fullName],
          });
        }
        break;
      }

      case "ValidationRule": {
        const object = comp.object!;
        roots.push({ object, event: "update", via: changeRef(change) }, { object, event: "insert", via: changeRef(change) });
        const vr = model.validationRules.find((v) => key(v.fullName) === key(comp.name));
        if (deleted || !vr) {
          addFinding({ rule: "validation-rule-removed", severity: "info", title: `Validation rule ${comp.name} removed`, detail: "Data that was previously blocked can now be saved.", object, files: [comp.file] });
          break;
        }
        if (!vr.active) {
          addFinding({ rule: "validation-rule-inactive", severity: "info", title: `Validation rule ${comp.name} is inactive`, detail: "Inactive rules do not run.", object, files: [vr.file] });
          break;
        }
        const writers = writersOf(model, object);
        if (writers.length) {
          addFinding({
            rule: "validation-rule-vs-existing-automation",
            severity: change.changeType === "added" ? "high" : "medium",
            title: `${change.changeType === "added" ? "New" : "Changed"} validation rule ${comp.name} applies to ${writers.length} automation(s) that write ${object}`,
            detail: `${writers.map((w) => describe(w.automation)).join(", ")} must now satisfy: ${vr.formula.replace(/\s+/g, " ").trim()}. If they don't set the fields it checks, their saves will fail.`,
            object,
            files: uniq([vr.file, ...writers.map((w) => w.automation.file!).filter(Boolean)]),
          });
          tests.push({
            kind: "validation-collision",
            object,
            description: `Run ${writers.map((w) => describe(w.automation)).join(", ")} against ${object} records that violate ${vr.name}; assert each either sets the required values or surfaces the error to the user (not swallowed).`,
            covers: [vr.fullName, ...writers.map((w) => w.automation.name)],
          });
        }
        break;
      }

      case "Flow": {
        const flow = model.flows.get(key(comp.name));
        changedAutomation.add(`flow:${key(comp.name)}`);
        if (deleted || !flow) {
          const parents = callersOfFlow(model, comp.name);
          if (parents.length) {
            addFinding({
              rule: "deleted-still-referenced",
              severity: "high",
              title: `Deleted flow ${comp.name} is still called as a subflow`,
              detail: `Called by ${parents.map((p) => p.name).join(", ")}.`,
              files: [comp.file, ...parents.map((p) => p.file)],
            });
          }
          break;
        }
        if (!flow.active) {
          addFinding({ rule: "flow-inactive", severity: "info", title: `Flow ${flow.name} is not active (${flow.status})`, detail: "It will not run until activated; analysis treats it as inactive.", files: [flow.file] });
        }
        const via: AutomationRef = { kind: "Flow", name: flow.name, file: flow.file };
        if (flow.trigger) {
          for (const event of flow.trigger.events) roots.push({ object: flow.trigger.object, event, via });
        } else {
          for (const w of flowWrites(model, flow)) roots.push({ object: w.object, event: opToEvent(w.op), via });
          for (const parent of callersOfFlow(model, flow.name)) {
            if (parent.trigger) for (const event of parent.trigger.events) roots.push({ object: parent.trigger.object, event, via: { kind: "Flow", name: parent.name, file: parent.file } });
          }
        }
        break;
      }

      case "ApexTrigger": {
        changedAutomation.add(`trigger:${key(comp.name)}`);
        const trig = model.triggers.get(key(comp.name));
        if (deleted || !trig) break;
        const via: AutomationRef = { kind: "ApexTrigger", name: trig.name, file: trig.file };
        for (const event of uniq(trig.events.map((e) => e.event))) roots.push({ object: trig.object, event, via });
        for (const cls of knownClassRefs(model, trig.classRefs)) changedAutomation.add(`class:${key(cls.name)}`);
        break;
      }

      case "ApexClass": {
        changedAutomation.add(`class:${key(comp.name)}`);
        const cls = model.classes.get(key(comp.name));
        if (deleted || !cls) {
          const callers = callersOfClass(model, comp.name);
          if (callers.length) {
            addFinding({
              rule: "deleted-still-referenced",
              severity: "high",
              title: `Deleted class ${comp.name} is still referenced`,
              detail: `Referenced by ${callers.map(describe).join(", ")}.`,
              files: uniq([comp.file, ...callers.map((c) => c.file!).filter(Boolean)]),
            });
          }
          break;
        }
        if (cls.isTest) break;
        const via: AutomationRef = { kind: "ApexClass", name: cls.name, file: cls.file };
        const entryPoints = transitiveEntryPoints(model, cls.name);
        for (const ep of entryPoints) {
          if (ep.kind === "ApexTrigger") {
            const trig = model.triggers.get(key(ep.name))!;
            for (const event of uniq(trig.events.map((e) => e.event))) roots.push({ object: trig.object, event, via: ep });
          } else if (ep.kind === "Flow") {
            const flow = model.flows.get(key(ep.name))!;
            if (flow.trigger) for (const event of flow.trigger.events) roots.push({ object: flow.trigger.object, event, via: ep });
          }
        }
        if (cls.invocable || !entryPoints.some((e) => e.kind === "ApexTrigger" || e.kind === "Flow")) {
          // Entry point in its own right (invocable action, agent action, LWC/Aura controller...).
          for (const w of classWrites(model, cls)) roots.push({ object: w.object, event: opToEvent(w.op), via });
        }
        break;
      }

      case "PermissionSet":
      case "Profile": {
        if (deleted) break;
        const current = model.permissionContainers.get(key(`${comp.type}:${comp.name}`));
        if (!current) break;
        const baseXml = opts.readBase?.(comp.file);
        let previous: PermissionContainerDef | undefined;
        if (baseXml) {
          try {
            previous = parsePermissionContainer(baseXml, comp.name, comp.type, comp.file);
          } catch {
            previous = undefined;
          }
        }
        const { findings: permFindings, tests: permTests } = permissionDelta(current, previous);
        findings.push(...permFindings);
        tests.push(...permTests);
        break;
      }

      case "CustomObject":
      case "ObjectChild":
        if (comp.object && !deleted) roots.push({ object: comp.object, event: "update", via: changeRef(change) });
        break;

      case "AgentMetadata":
        addFinding({
          rule: "agent-metadata-changed",
          severity: "info",
          title: `Agentforce metadata changed: ${comp.name}`,
          detail: "Agent action verification (decision + execution layer) is planned for milestone M5. Run Agentforce Testing Center for the decision layer in the meantime.",
          files: [comp.file],
        });
        break;

      case "WorkflowRule":
        addFinding({ rule: "legacy-workflow", severity: "info", title: `Legacy workflow changed: ${comp.name}`, detail: "Workflow rules are not analyzed yet; consider migrating them to flows.", files: [comp.file] });
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------------------------------------
  // 2. Cascade through the save procedure of every impacted object
  // ------------------------------------------------------------------------------------
  const procCache = new Map<string, SaveProcedure>();
  const proc = (object: string, event: SaveEvent) => {
    const k = `${key(object)}|${event}`;
    let p = procCache.get(k);
    if (!p) {
      p = saveProcedure(model, model.objects.get(key(object))?.name ?? object, event);
      procCache.set(k, p);
    }
    return p;
  };

  let nodeCount = 0;
  const cycleMap = new Map<string, string[]>();
  const label = (n: { object: string; event: SaveEvent; via?: AutomationRef }) =>
    `${n.object} (${n.event})${n.via && n.via.kind !== "Change" ? ` ← ${describe(n.via)}` : ""}`;

  const expand = (node: CascadeNode, path: CascadeNode[]) => {
    if (node.depth >= maxDepth) {
      if (proc(node.object, node.event).steps.some((s) => s.writes.length)) node.truncated = true;
      return;
    }
    const seen = new Set<string>();
    for (const step of proc(node.object, node.event).steps) {
      for (const w of step.writes) {
        const event = opToEvent(w.op);
        const childKey = `${key(w.object)}|${event}|${step.automation.kind}|${step.automation.name}`;
        if (seen.has(childKey)) continue;
        seen.add(childKey);
        if (++nodeCount > MAX_NODES) {
          node.truncated = true;
          return;
        }
        const child: CascadeNode = { object: w.object, event, via: step.automation, depth: node.depth + 1, children: [] };
        node.children.push(child);
        const loopStart = path.findIndex((p) => key(p.object) === key(w.object));
        if (loopStart >= 0) {
          child.cycle = true;
          const loop = [...path.slice(loopStart), child];
          const signature = loop
            .slice(1)
            .map((n) => `${key(n.object)}|${n.via?.name ?? ""}`)
            .sort()
            .join(">");
          if (!cycleMap.has(signature)) cycleMap.set(signature, loop.map(label));
          continue;
        }
        expand(child, [...path, child]);
      }
    }
  };

  const uniqueRoots = uniqBy(roots, (r) => `${key(r.object)}|${r.event}|${r.via.kind}|${key(r.via.name)}`);
  const cascade: CascadeNode[] = uniqueRoots.map((r) => {
    const node: CascadeNode = {
      object: model.objects.get(key(r.object))?.name ?? r.object,
      event: r.event,
      via: r.via,
      depth: 0,
      children: [],
    };
    expand(node, [node]);
    return node;
  });

  // Collect visited (object, event) pairs and edges.
  const visited = new Map<string, { object: string; event: SaveEvent }>();
  const edges: CascadeNode[] = [];
  const walk = (n: CascadeNode) => {
    visited.set(`${key(n.object)}|${n.event}`, { object: n.object, event: n.event });
    edges.push(n);
    n.children.forEach(walk);
  };
  cascade.forEach(walk);

  const saveProcedures = [...visited.values()].map((v) => proc(v.object, v.event)).filter((p) => p.steps.length > 0);
  const impactedObjects = uniq([...visited.values()].map((v) => v.object)).sort();

  // ------------------------------------------------------------------------------------
  // 3. Findings from the cascade
  // ------------------------------------------------------------------------------------
  const cycles = [...cycleMap.values()];
  for (const loop of cycles) {
    addFinding({
      rule: "recursion-cycle",
      severity: "high",
      title: `Automation cycle: ${loop.map((l) => l.split(" ")[0]).join(" → ")}`,
      detail: `${loop.join(" → ")}. At human pace this may settle; at bulk or agent volume it can cause recursion, duplicate updates or governor-limit failures mid-batch.`,
      files: [],
    });
    tests.push({
      kind: "recursion",
      object: loop[0]?.split(" ")[0],
      description: `In one transaction, update 200 records along ${loop.map((l) => l.split(" ")[0]).join(" → ")}; assert no recursion/limit errors, no duplicate updates, and consistent final values.`,
      covers: loop,
    });
  }

  // Validation rules hit by automated writes.
  const automatedWrites = new Map<string, { object: string; writers: Map<string, AutomationRef> }>();
  for (const e of edges) {
    if (!e.via || !AUTOMATION_KINDS.has(e.via.kind) || (e.event !== "insert" && e.event !== "update")) continue;
    const k = key(e.object);
    if (!automatedWrites.has(k)) automatedWrites.set(k, { object: e.object, writers: new Map() });
    automatedWrites.get(k)!.writers.set(`${e.via.kind}:${e.via.name}`, e.via);
  }
  for (const { object, writers } of automatedWrites.values()) {
    const vrs = model.validationRules.filter((v) => v.active && key(v.object) === key(object));
    if (!vrs.length) continue;
    const ws = [...writers.values()];
    addFinding({
      rule: "automated-write-vs-validation-rule",
      severity: "medium",
      title: `Automated writes to ${object} must pass ${vrs.length} validation rule(s)`,
      detail: `${ws.map(describe).join(", ")} write ${object} records that are checked by ${vrs.map((v) => v.name).join(", ")}. A correct action can still fail here; verify errors are surfaced, not swallowed.`,
      object,
      files: uniq([...vrs.map((v) => v.file), ...ws.map((w) => w.file!).filter(Boolean)]),
    });
    tests.push({
      kind: "validation-collision",
      object,
      description: `Exercise ${ws.map(describe).join(", ")} with ${object} data that violates ${vrs.map((v) => v.name).join(", ")}; assert the failure is reported to the caller and no partial updates remain.`,
      covers: [...vrs.map((v) => v.fullName), ...ws.map((w) => w.name)],
    });
  }

  // Automation density and self re-entry on visited save procedures.
  for (const p of saveProcedures) {
    const automations = p.steps.filter((s) => s.automation.kind === "Flow" || s.automation.kind === "ApexTrigger");
    const uniqueAutomations = uniq(automations.map((s) => s.automation.name));
    if (uniqueAutomations.length >= 3) {
      addFinding({
        rule: "automation-density",
        severity: "medium",
        title: `${uniqueAutomations.length} automations run on ${p.object} ${p.event}`,
        detail: `${uniqueAutomations.join(", ")}. Overlapping automation on one object is where ordering bugs and race conditions hide.`,
        object: p.object,
        files: uniq(automations.map((s) => s.automation.file!).filter(Boolean)),
      });
    }
    const triggers = uniq(p.steps.filter((s) => s.automation.kind === "ApexTrigger").map((s) => s.automation.name));
    if (triggers.length > 1) {
      addFinding({
        rule: "multiple-triggers",
        severity: "medium",
        title: `${triggers.length} Apex triggers on ${p.object}`,
        detail: `${triggers.join(", ")}. Salesforce does not guarantee the order between triggers on the same object; consolidate into one trigger per object.`,
        object: p.object,
        files: uniq(p.steps.filter((s) => s.automation.kind === "ApexTrigger").map((s) => s.automation.file!)),
      });
    }
    for (const s of p.steps) {
      if (s.phase === "after-flow" && s.writes.some((w) => w.selfUpdate)) {
        addFinding({
          rule: "after-save-self-update",
          severity: "medium",
          title: `After-save flow ${s.automation.name} updates its own triggering ${p.object}`,
          detail: "This re-runs the whole save procedure for the record. Use a before-save flow for same-record field updates.",
          object: p.object,
          files: [s.automation.file!],
        });
        tests.push({
          kind: "idempotency",
          object: p.object,
          description: `Save the same ${p.object} twice in a row; assert ${s.automation.name} does not double-apply its changes.`,
          covers: [s.automation.name],
        });
      }
    }
  }

  // DML/SOQL inside loops in changed or impacted Apex.
  const apexInScope = new Map<string, { name: string; file: string; issues: LoopIssue[]; changed: boolean }>();
  const addApex = (kind: "class" | "trigger", name: string) => {
    const def = kind === "class" ? model.classes.get(key(name)) : model.triggers.get(key(name));
    if (!def || !def.loopIssues.length) return;
    const k = `${kind}:${key(name)}`;
    const changed = changedAutomation.has(k) || changedFiles.has(def.file);
    const prev = apexInScope.get(k);
    apexInScope.set(k, { name: def.name, file: def.file, issues: def.loopIssues, changed: changed || !!prev?.changed });
  };
  for (const k of changedAutomation) {
    const [kind, name] = k.split(":") as ["class" | "trigger" | "flow", string];
    if (kind !== "flow") addApex(kind, name);
  }
  for (const p of saveProcedures) {
    for (const s of p.steps) {
      if (s.automation.kind !== "ApexTrigger") continue;
      addApex("trigger", s.automation.name);
      const trig = model.triggers.get(key(s.automation.name));
      if (trig) for (const cls of knownClassRefs(model, trig.classRefs)) addApex("class", cls.name);
    }
  }
  for (const a of apexInScope.values()) {
    addFinding({
      rule: "dml-or-soql-in-loop",
      severity: a.changed ? "high" : "medium",
      title: `${a.issues.length} DML/SOQL statement(s) inside loops in ${a.name}${a.changed ? " (changed)" : " (in blast radius)"}`,
      detail: a.issues.map((i) => `line ${i.line} ${i.kind}: ${i.snippet}`).join("; "),
      files: [a.file],
    });
  }

  // Bulk tests for every root.
  for (const r of uniqBy(uniqueRoots, (r) => `${key(r.object)}|${r.event}`)) {
    const p = proc(r.object, r.event);
    tests.push({
      kind: "bulk",
      object: r.object,
      description: `Bulk ${r.event} 200 ${r.object} records (and at your expected production volume); assert no governor-limit errors and the expected final state.`,
      covers: uniq(p.steps.map((s) => s.automation.name)),
    });
  }

  // ------------------------------------------------------------------------------------
  // 4. Summary
  // ------------------------------------------------------------------------------------
  const finalFindings = uniqBy(findings, (f) => `${f.rule}|${f.title}`).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const findingsBySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of finalFindings) findingsBySeverity[f.severity]++;
  const automationsInvolved = uniq(saveProcedures.flatMap((p) => p.steps.map((s) => `${s.automation.kind}:${s.automation.name}`))).length;
  const risk = findingsBySeverity.high ? "high" : findingsBySeverity.medium ? "medium" : "low";

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectDir: model.projectDir,
    base: opts.base,
    head: opts.head,
    changes,
    ignoredFiles: opts.ignoredFiles ?? [],
    references,
    impactedObjects,
    saveProcedures,
    cascade,
    cycles,
    findings: finalFindings,
    suggestedTests: uniqBy(tests, (t) => `${t.kind}|${t.description}`),
    summary: {
      risk,
      changedComponents: changes.length,
      impactedObjects: impactedObjects.length,
      automationsInvolved,
      cycles: cycles.length,
      findingsBySeverity,
    },
    warnings: model.warnings,
  };
}

// ----------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------

/** Everything in the project that references `Object.Field`. */
export function fieldReferences(model: OrgModel, object: string, field: string): Reference[] {
  const target = `${object}.${field}`;
  const fk = key(field);
  const tk = key(target);
  const refs: Reference[] = [];

  for (const vr of model.validationRules) {
    if (key(vr.object) === key(object) && vr.fieldRefs.some((r) => key(r) === fk)) {
      refs.push({ from: { kind: "ValidationRule", name: vr.name, file: vr.file }, to: target });
    }
  }
  for (const flow of model.flows.values()) {
    if (flow.fieldRefs.some((r) => key(r) === tk)) refs.push({ from: { kind: "Flow", name: flow.name, file: flow.file }, to: target });
  }
  if (fk.endsWith("__c")) {
    const re = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    for (const trig of model.triggers.values()) {
      if (re.test(trig.stripped)) refs.push({ from: { kind: "ApexTrigger", name: trig.name, file: trig.file }, to: target });
    }
    for (const cls of model.classes.values()) {
      if (re.test(cls.stripped)) refs.push({ from: { kind: "ApexClass", name: cls.name, file: cls.file }, to: target });
    }
  }
  for (const obj of model.objects.values()) {
    for (const f of obj.fields.values()) {
      if (key(obj.name) === key(object) && key(f.name) !== fk && f.formulaRefs.some((r) => key(r) === fk)) {
        refs.push({ from: { kind: "FormulaField", name: f.fullName, file: f.file }, to: target });
      }
      if (f.summary && key(f.summary.childObject) === key(object)) {
        const summarized = f.summary.summarizedField && key(f.summary.summarizedField) === tk;
        const filtered = f.summary.filterFields.some((ff) => key(ff) === fk || key(ff) === tk);
        if (summarized || filtered) refs.push({ from: { kind: "RollUpSummary", name: f.fullName, file: f.file }, to: target });
      }
    }
  }
  for (const pc of model.permissionContainers.values()) {
    if (pc.fields.some((g) => key(g.field) === tk)) refs.push({ from: { kind: pc.kind, name: pc.name, file: pc.file }, to: target });
  }
  return refs;
}

/** Triggers and record-triggered flows that (transitively) call a class. */
function transitiveEntryPoints(model: OrgModel, className: string): AutomationRef[] {
  const result: AutomationRef[] = [];
  const seen = new Set<string>();
  const queue = [className];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(key(name))) continue;
    seen.add(key(name));
    for (const caller of callersOfClass(model, name)) {
      if (caller.kind === "ApexClass") queue.push(caller.name);
      else result.push(caller);
    }
  }
  return uniqBy(result, (r) => `${r.kind}|${key(r.name)}`);
}

function permissionDelta(
  current: PermissionContainerDef,
  previous: PermissionContainerDef | undefined,
): { findings: Finding[]; tests: SuggestedTest[] } {
  const findings: Finding[] = [];
  const tests: SuggestedTest[] = [];
  const scope = previous ? "newly grants" : "grants";
  const prevObj = new Map((previous?.objects ?? []).map((o) => [key(o.object), o]));
  const label = `${current.kind === "Profile" ? "Profile" : "Permission set"} ${current.name}`;

  for (const o of current.objects) {
    const p = prevObj.get(key(o.object));
    const escalations: string[] = [];
    if (o.modifyAll && !p?.modifyAll) escalations.push("Modify All");
    if (o.viewAll && !p?.viewAll) escalations.push("View All");
    if (escalations.length) {
      findings.push({
        rule: "permission-escalation",
        severity: "high",
        title: `${label} ${scope} ${escalations.join(" + ")} on ${o.object}`,
        detail: `Anyone with this ${current.kind === "Profile" ? "profile" : "permission set"} — including an agent's runtime user — bypasses sharing on ${o.object}. Confirm this is intended and scoped.`,
        object: o.object,
        files: [current.file],
      });
      tests.push({
        kind: "permission-negative",
        object: o.object,
        description: `As a user holding only ${current.name}, attempt to read/edit ${o.object} records outside the intended scope; assert access is denied (System.runAs).`,
        covers: [current.name],
      });
    }
    if (o.delete && !p?.delete) {
      findings.push({
        rule: "permission-delete",
        severity: "medium",
        title: `${label} ${scope} delete on ${o.object}`,
        detail: "Delete access is rarely needed by integration or agent users; deletes cascade through master-detail children.",
        object: o.object,
        files: [current.file],
      });
    }
  }
  const prevUser = new Set((previous?.userPermissions ?? []).map(key));
  for (const up of current.userPermissions) {
    if (SENSITIVE_USER_PERMS.has(key(up)) && !prevUser.has(key(up))) {
      findings.push({
        rule: "permission-system",
        severity: "high",
        title: `${label} ${scope} system permission ${up}`,
        detail: "System-level permission with org-wide blast radius.",
        files: [current.file],
      });
    }
  }
  if (previous) {
    const prevFields = new Map(previous.fields.map((f) => [key(f.field), f]));
    const newEdits = current.fields.filter((f) => f.editable && !prevFields.get(key(f.field))?.editable);
    if (newEdits.length) {
      findings.push({
        rule: "permission-field-edit",
        severity: "low",
        title: `${label} newly grants edit on ${newEdits.length} field(s)`,
        detail: newEdits.map((f) => f.field).join(", "),
        files: [current.file],
      });
    }
  }
  return { findings, tests };
}
