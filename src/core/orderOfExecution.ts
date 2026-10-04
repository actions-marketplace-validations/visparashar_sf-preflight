// SPDX-License-Identifier: Apache-2.0
import { flowWrites, triggerWrites } from "./graph.js";
import type { OrgModel, Phase, SaveEvent, SaveProcedure, SaveStep, Write } from "./types.js";
import { key } from "./util.js";

/**
 * Simplified Salesforce order of execution for a single DML event on one object.
 *
 * 1. Before-save record-triggered flows (and before-delete flows)
 * 2. Before triggers
 * 3. Custom validation rules (insert/update only)
 * 4. After triggers
 * 5. After-save record-triggered flows
 * 6. Roll-up summary recalculation on master records (the parent re-enters its own save)
 *
 * Duplicate rules, assignment/auto-response rules, legacy workflow, escalation rules and
 * criteria-based sharing are not modelled yet. Order *within* a phase follows Salesforce's
 * flow trigger order where set; otherwise it is undefined in Salesforce and alphabetical here.
 */
export const PHASE_LABELS: Record<Phase, string> = {
  "before-flow": "Before-save flow",
  "before-trigger": "Before trigger",
  validation: "Validation rule",
  "after-trigger": "After trigger",
  "after-flow": "After-save flow",
  rollup: "Roll-up summary",
};

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function saveProcedure(model: OrgModel, object: string, event: SaveEvent): SaveProcedure {
  const k = key(object);
  const steps: Omit<SaveStep, "order">[] = [];

  const flows = [...model.flows.values()]
    .filter((f) => f.active && f.trigger && key(f.trigger.object) === k && f.trigger.events.includes(event))
    .sort(byName);
  const triggers = [...model.triggers.values()].filter((t) => key(t.object) === k).sort(byName);

  for (const flow of flows.filter((f) => f.trigger!.timing === "before")) {
    // Before-save flows change the record in memory; their $Record "updates" are not DML.
    const writes = flowWrites(model, flow).filter((w) => !w.selfUpdate);
    const notes = flow.trigger!.entryFields.length ? [`entry criteria on ${flow.trigger!.entryFields.join(", ")}`] : [];
    steps.push({
      phase: "before-flow",
      phaseLabel: PHASE_LABELS["before-flow"],
      automation: { kind: "Flow", name: flow.name, file: flow.file, phase: "before-flow" },
      writes,
      notes,
    });
  }

  for (const timing of ["before", "after"] as const) {
    if (timing === "after" && event !== "delete") {
      // validation rules sit between before and after triggers
      for (const vr of model.validationRules.filter((v) => v.active && key(v.object) === k).sort(byName)) {
        if (event !== "insert" && event !== "update") continue;
        steps.push({
          phase: "validation",
          phaseLabel: PHASE_LABELS.validation,
          automation: { kind: "ValidationRule", name: vr.name, file: vr.file, phase: "validation" },
          writes: [],
          notes: vr.fieldRefs.length ? [`checks ${vr.fieldRefs.join(", ")}`] : [],
        });
      }
    }
    const phase: Phase = timing === "before" ? "before-trigger" : "after-trigger";
    for (const trig of triggers.filter((t) => t.events.some((e) => e.timing === timing && e.event === event))) {
      // Attribute DML to the after phase when the trigger has one for this event, else to before.
      const hasAfter = trig.events.some((e) => e.timing === "after" && e.event === event);
      const writes = timing === "after" || !hasAfter ? triggerWrites(model, trig) : [];
      steps.push({
        phase,
        phaseLabel: PHASE_LABELS[phase],
        automation: { kind: "ApexTrigger", name: trig.name, file: trig.file, phase },
        writes,
        notes: [],
      });
    }
  }

  for (const flow of flows.filter((f) => f.trigger!.timing === "after")) {
    const writes = flowWrites(model, flow);
    const notes: string[] = [];
    if (flow.trigger!.entryFields.length) notes.push(`entry criteria on ${flow.trigger!.entryFields.join(", ")}`);
    if (writes.some((w) => w.selfUpdate)) notes.push("updates its own triggering record (re-enters the save)");
    if (flow.trigger!.hasScheduledPaths) notes.push("has scheduled paths (runs asynchronously later)");
    steps.push({
      phase: "after-flow",
      phaseLabel: PHASE_LABELS["after-flow"],
      automation: { kind: "Flow", name: flow.name, file: flow.file, phase: "after-flow" },
      writes,
      notes,
    });
  }

  for (const parent of model.objects.values()) {
    for (const field of parent.fields.values()) {
      if (!field.summary || key(field.summary.childObject) !== k) continue;
      const write: Write = {
        object: parent.name,
        op: "update",
        fields: [field.name],
        via: "roll-up summary",
        confidence: "high",
      };
      steps.push({
        phase: "rollup",
        phaseLabel: PHASE_LABELS.rollup,
        automation: { kind: "RollUpSummary", name: field.fullName, file: field.file, phase: "rollup" },
        writes: [write],
        notes: [
          `${field.summary.operation ?? "summary"} of ${field.summary.summarizedField ?? field.summary.childObject}`,
        ],
      });
    }
  }

  return { object, event, steps: steps.map((s, i) => ({ ...s, order: i + 1 })) };
}
