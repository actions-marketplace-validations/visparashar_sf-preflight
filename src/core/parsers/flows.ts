// SPDX-License-Identifier: Apache-2.0
import type { DmlOp, FlowDef, FlowTrigger, SaveEvent, Timing, Write } from "../types.js";
import { nodes, parseMetadataXml, text, uniq, uniqBy, type XmlNode } from "../util.js";

const RECORD_TRIGGER_EVENTS: Record<string, SaveEvent[]> = {
  Create: ["insert"],
  Update: ["update"],
  CreateAndUpdate: ["insert", "update"],
  Delete: ["delete"],
};

const TRIGGER_TIMING: Record<string, Timing> = {
  RecordBeforeSave: "before",
  RecordAfterSave: "after",
  RecordBeforeDelete: "before",
};

/**
 * Parse a `.flow-meta.xml` file.
 *
 * Resolves which objects the flow writes to, including `$Record` (the triggering record),
 * typed SObject variables, Get Records outputs and loop variables.
 */
export function parseFlow(xml: string, fallbackName: string, file: string): FlowDef {
  const { body } = parseMetadataXml(xml);
  const status = text(body.status) ?? "Active";
  const processType = text(body.processType);

  const trigger = parseTrigger(body.start as XmlNode | undefined);

  // --- symbol table: name -> SObject type -----------------------------------------
  const symbols = new Map<string, string>();
  for (const v of nodes(body.variables)) {
    const name = text(v.name);
    const objectType = text(v.objectType);
    if (name && objectType && text(v.dataType) === "SObject") symbols.set(name.toLowerCase(), objectType);
  }
  for (const lookup of nodes(body.recordLookups)) {
    const name = text(lookup.name);
    const object = text(lookup.object);
    if (name && object) symbols.set(name.toLowerCase(), object);
  }
  const loopSources = new Map<string, string>();
  for (const loop of nodes(body.loops)) {
    const name = text(loop.name);
    const source = text(loop.collectionReference);
    if (name && source) loopSources.set(name.toLowerCase(), source);
  }

  const resolve = (ref: string | undefined, depth = 0): { object?: string; self: boolean } => {
    if (!ref || depth > 5) return { self: false };
    if (ref === "$Record") return { object: trigger?.object, self: true };
    if (ref.startsWith("$Record")) return { self: false }; // relationship path, unresolved
    const head = ref.split(".")[0]!.toLowerCase();
    const sym = symbols.get(head);
    if (sym) return { object: sym, self: false };
    const loopSource = loopSources.get(head);
    if (loopSource) return resolve(loopSource, depth + 1);
    return { self: false };
  };

  const writes: Write[] = [];
  const fieldRefs: string[] = [];
  const addWrite = (el: XmlNode, op: DmlOp) => {
    const elementName = text(el.name);
    let object = text(el.object);
    let self = false;
    let confidence: Write["confidence"] = "high";
    if (!object) {
      const resolved = resolve(text(el.inputReference));
      object = resolved.object;
      self = resolved.self;
      if (!object) return;
      if (!self) confidence = "medium";
    }
    const fields = uniq(
      nodes(el.inputAssignments)
        .map((a) => text(a.field))
        .filter((f): f is string => !!f),
    );
    for (const f of fields) fieldRefs.push(`${object}.${f}`);
    for (const filter of nodes(el.filters)) {
      const f = text(filter.field);
      if (f) fieldRefs.push(`${object}.${f}`);
    }
    writes.push({ object, op, fields, selfUpdate: self || undefined, via: elementName, confidence });
  };

  for (const el of nodes(body.recordUpdates)) addWrite(el, "update");
  for (const el of nodes(body.recordCreates)) addWrite(el, "insert");
  for (const el of nodes(body.recordDeletes)) addWrite(el, "delete");

  const reads: string[] = [];
  for (const el of nodes(body.recordLookups)) {
    const object = text(el.object);
    if (!object) continue;
    reads.push(object);
    for (const filter of nodes(el.filters)) {
      const f = text(filter.field);
      if (f) fieldRefs.push(`${object}.${f}`);
    }
  }

  const apexActions = uniq(
    nodes(body.actionCalls)
      .filter((a) => text(a.actionType)?.toLowerCase() === "apex")
      .map((a) => text(a.actionName))
      .filter((a): a is string => !!a),
  );
  const subflows = uniq(
    nodes(body.subflows)
      .map((s) => text(s.flowName))
      .filter((s): s is string => !!s),
  );

  if (trigger) {
    for (const f of trigger.entryFields) fieldRefs.push(`${trigger.object}.${f}`);
    // Catch-all: any $Record.Field / $Record__Prior.Field mention in the document.
    for (const m of xml.matchAll(/\$Record(?:__Prior)?\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      fieldRefs.push(`${trigger.object}.${m[1]}`);
    }
  }

  return {
    name: fallbackName,
    label: text(body.label),
    status,
    active: status === "Active",
    processType,
    trigger,
    writes: uniqBy(writes, (w) => `${w.object}|${w.op}|${w.via}`),
    reads: uniq(reads),
    apexActions,
    subflows,
    fieldRefs: uniqBy(fieldRefs, (f) => f.toLowerCase()),
    file,
  };
}

function parseTrigger(start: XmlNode | undefined): FlowTrigger | undefined {
  if (!start) return undefined;
  const object = text(start.object);
  const triggerType = text(start.triggerType);
  const recordTriggerType = text(start.recordTriggerType);
  if (!object || !triggerType || !(triggerType in TRIGGER_TIMING)) return undefined;
  const events =
    triggerType === "RecordBeforeDelete"
      ? (["delete"] as SaveEvent[])
      : (RECORD_TRIGGER_EVENTS[recordTriggerType ?? ""] ?? ["insert", "update"]);
  const entryFields = uniq(
    nodes(start.filters)
      .map((f) => text(f.field))
      .filter((f): f is string => !!f),
  );
  const filterFormula = text(start.filterFormula);
  if (filterFormula) {
    for (const m of filterFormula.matchAll(/\$Record(?:__Prior)?\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (m[1]) entryFields.push(m[1]);
    }
  }
  return {
    object,
    timing: TRIGGER_TIMING[triggerType]!,
    events,
    entryFields: uniq(entryFields),
    hasScheduledPaths: nodes(start.scheduledPaths).length > 0,
  };
}
