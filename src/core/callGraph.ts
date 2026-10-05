// SPDX-License-Identifier: Apache-2.0
import type { ApexAnalysis, LoopIssue, OrgModel } from "./types.js";
import { key, uniqBy } from "./util.js";

/**
 * Cross-method / cross-class pass over AST-parsed Apex.
 *
 * Computes, for every method, whether it performs DML or SOQL itself or through anything it
 * calls (transitively, across classes in the project), then reports loops that call such a
 * method. This finds the classic "helper does a query, helper is called in a loop" bug that a
 * per-statement check misses. Overloads are merged by name (conservative).
 */
interface Summary {
  dml: boolean;
  soql: boolean;
  callees: string[];
}

const methodKey = (cls: string, method: string) => `${key(cls)}#${key(method)}`;

interface Unit {
  name: string;
  def: ApexAnalysis;
}

function units(model: OrgModel): Unit[] {
  const out: Unit[] = [];
  for (const c of model.classes.values()) if (c.parser === "ast" && !c.isTest) out.push({ name: c.name, def: c });
  for (const t of model.triggers.values()) if (t.parser === "ast") out.push({ name: t.name, def: t });
  return out;
}

export function applyCallGraph(model: OrgModel): void {
  const all = units(model);
  const summaries = new Map<string, Summary>();
  for (const u of all) {
    for (const m of u.def.methods ?? []) {
      const callees = (u.def.calls ?? [])
        .filter((c) => key(c.from) === key(m.name))
        .map((c) => methodKey(c.cls ?? u.name, c.method));
      summaries.set(methodKey(u.name, m.name), { dml: m.dml, soql: m.soql, callees });
    }
  }

  // Fixpoint: propagate DML/SOQL from callees to callers.
  let changed = true;
  for (let i = 0; changed && i <= summaries.size; i++) {
    changed = false;
    for (const s of summaries.values()) {
      for (const k of s.callees) {
        const callee = summaries.get(k);
        if (!callee) continue;
        if (callee.dml && !s.dml) {
          s.dml = true;
          changed = true;
        }
        if (callee.soql && !s.soql) {
          s.soql = true;
          changed = true;
        }
      }
    }
  }

  const displayName = new Map<string, string>();
  for (const u of all)
    for (const m of u.def.methods ?? []) displayName.set(methodKey(u.name, m.name), `${u.name}.${m.name}`);

  for (const u of all) {
    const added: LoopIssue[] = [];
    for (const c of u.def.calls ?? []) {
      if (!c.inLoop) continue;
      const k = methodKey(c.cls ?? u.name, c.method);
      const callee = summaries.get(k);
      if (!callee) continue;
      const via = displayName.get(k) ?? `${c.cls ?? u.name}.${c.method}`;
      if (callee.soql) added.push({ kind: "soql-in-loop", line: c.line, snippet: c.snippet, via });
      if (callee.dml) added.push({ kind: "dml-in-loop", line: c.line, snippet: c.snippet, via });
    }
    if (added.length) {
      u.def.loopIssues = uniqBy([...u.def.loopIssues, ...added], (l) => `${l.kind}|${l.line}|${l.via ?? ""}`).sort(
        (a, b) => a.line - b.line,
      );
    }
  }
}
