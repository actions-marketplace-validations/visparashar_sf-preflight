// SPDX-License-Identifier: Apache-2.0
import { looksLikeSObject, SYSTEM_CLASSES } from "../standardObjects.js";
import type {
  ApexAnalysis,
  ApexClassDef,
  ApexTriggerDef,
  DmlOp,
  LoopIssue,
  SaveEvent,
  Timing,
  Write,
} from "../types.js";
import { lineOf, uniq, uniqBy } from "../util.js";
import { analyzeApexAst } from "./apexAst.js";

/**
 * Apex entry points. Source is parsed with the Apex grammar (see apexAst.ts); when a file has
 * syntax errors the regex-based heuristic analysis below is used instead, so one broken file
 * never stops the run.
 */

/** Blank out comments and string literal contents, preserving offsets and newlines. */
export function stripApex(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (j: number) => {
    if (out[j] !== "\n") out[j] = " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && d === "*") {
      blank(i++);
      blank(i++);
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'" && src[i] !== "\n") {
        if (src[i] === "\\") blank(i++);
        if (i < n) blank(i++);
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

function findMatching(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const DML_STATEMENT = /(?<![\w.])(insert|update|upsert|delete|undelete)\s+([^;]+);/gi;
const DML_DATABASE = /\bDatabase\s*\.\s*(insert|update|upsert|delete|undelete)(?:Immediate|Async)?\s*\(\s*([^,;]+)/gi;
const SOQL = /\[\s*SELECT\b[\s\S]*?\bFROM\s+(\w+)/gi;

interface Context {
  projectObjects: Set<string>;
  triggerObject?: string;
}

export function analyzeApex(source: string, ctx: Context, stripped = stripApex(source)): ApexAnalysis {
  const s = stripped;
  const lines = source.split("\n");

  // --- declared SObject-typed variables -------------------------------------------
  const types = new Map<string, string>();
  const declare = (type: string | undefined, name: string | undefined) => {
    if (!type || !name) return;
    if (looksLikeSObject(type, ctx.projectObjects)) types.set(name.toLowerCase(), type);
  };
  for (const m of s.matchAll(/\b(?:List|Set)\s*<\s*(\w+)\s*>\s+(\w+)/gi)) declare(m[1], m[2]);
  for (const m of s.matchAll(/\bMap\s*<\s*\w+\s*,\s*(\w+)\s*>\s+(\w+)/gi)) declare(m[1], m[2]);
  for (const m of s.matchAll(/\b(\w+)\s*\[\s*\]\s+(\w+)/g)) declare(m[1], m[2]);
  for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?=[=;,):])/g)) declare(m[1], m[2]);

  const resolve = (exprRaw: string): { object?: string; self?: boolean; confidence: Write["confidence"] } => {
    let expr = exprRaw.trim().replace(/^this\s*\.\s*/i, "");
    let m = expr.match(/^\(\s*(?:List\s*<\s*(\w+)\s*>|(\w+))\s*\)\s*/i);
    if (m) {
      const cast = m[1] ?? m[2];
      if (cast && looksLikeSObject(cast, ctx.projectObjects)) return { object: cast, confidence: "high" };
      expr = expr.slice(m[0].length);
    }
    m = expr.match(/^new\s+(?:List\s*<\s*(\w+)\s*>|(\w+))\s*[({]/i);
    if (m) return { object: m[1] ?? m[2], confidence: "high" };
    m = expr.match(/^\[\s*SELECT\b[\s\S]*?\bFROM\s+(\w+)/i);
    if (m) return { object: m[1], confidence: "high" };
    if (/^trigger\s*\.\s*(new|old|newmap|oldmap)\b/i.test(expr) && ctx.triggerObject) {
      return { object: ctx.triggerObject, self: true, confidence: "high" };
    }
    m = expr.match(/^(\w+)/);
    const t = m?.[1] ? types.get(m[1].toLowerCase()) : undefined;
    if (t) return { object: t, confidence: "medium" };
    return { confidence: "low" };
  };

  const writes: Write[] = [];
  let unresolvedDml = 0;
  const collectDml = (
    regex: RegExp,
    text: string,
    offset: number,
    sink: (op: DmlOp, idx: number, expr: string) => void,
  ) => {
    for (const m of text.matchAll(regex)) {
      sink(m[1]!.toLowerCase() as DmlOp, offset + (m.index ?? 0), m[2] ?? "");
    }
  };
  const onDml = (op: DmlOp, idx: number, expr: string) => {
    const r = resolve(expr);
    if (!r.object) {
      unresolvedDml++;
      return;
    }
    writes.push({
      object: r.object,
      op,
      selfUpdate: r.self || undefined,
      via: `line ${lineOf(s, idx)}`,
      confidence: r.confidence,
    });
  };
  collectDml(DML_STATEMENT, s, 0, onDml);
  collectDml(DML_DATABASE, s, 0, onDml);

  const reads = uniq([...s.matchAll(SOQL)].map((m) => m[1]!).filter(Boolean));

  // --- DML / SOQL inside loops ------------------------------------------------------
  const loopIssues: LoopIssue[] = [];
  const bodies: Array<[number, number]> = [];
  for (const m of s.matchAll(/\b(?:for|while)\s*\(/gi)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = findMatching(s, open, "(", ")");
    if (close < 0) continue;
    const brace = s.slice(close + 1).search(/\S/);
    const braceIdx = close + 1 + brace;
    if (brace < 0 || s[braceIdx] !== "{") continue;
    const end = findMatching(s, braceIdx, "{", "}");
    if (end > 0) bodies.push([braceIdx, end]);
  }
  for (const m of s.matchAll(/\bdo\s*\{/gi)) {
    const braceIdx = (m.index ?? 0) + m[0].length - 1;
    const end = findMatching(s, braceIdx, "{", "}");
    if (end > 0) bodies.push([braceIdx, end]);
  }
  for (const [start, end] of bodies) {
    const body = s.slice(start, end);
    for (const m of body.matchAll(SOQL)) {
      const line = lineOf(s, start + (m.index ?? 0));
      loopIssues.push({ kind: "soql-in-loop", line, snippet: (lines[line - 1] ?? "").trim() });
    }
    const dmlSink = (_op: DmlOp, idx: number) => {
      const line = lineOf(s, idx);
      loopIssues.push({ kind: "dml-in-loop", line, snippet: (lines[line - 1] ?? "").trim() });
    };
    collectDml(DML_STATEMENT, body, start, dmlSink);
    collectDml(DML_DATABASE, body, start, dmlSink);
  }

  // --- class references -----------------------------------------------------------
  const classRefs = new Set<string>();
  for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\.\s*[A-Za-z_]\w*\s*\(/g)) classRefs.add(m[1]!);
  for (const m of s.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) classRefs.add(m[1]!);
  for (const c of [...classRefs]) {
    if (SYSTEM_CLASSES.has(c.toLowerCase()) || looksLikeSObject(c, ctx.projectObjects)) classRefs.delete(c);
  }

  return {
    writes: uniqBy(writes, (w) => `${w.object.toLowerCase()}|${w.op}|${w.via}`),
    reads,
    classRefs: [...classRefs],
    loopIssues: uniqBy(loopIssues, (l) => `${l.kind}|${l.line}`).sort((a, b) => a.line - b.line),
    unresolvedDml,
    stripped: s,
  };
}

export function parseApexClass(source: string, name: string, file: string, projectObjects: Set<string>): ApexClassDef {
  const stripped = stripApex(source);
  const ast = analyzeApexAst(source, { projectObjects, kind: "class" });
  if (!("errors" in ast)) {
    const { name: _parsedName, triggerObject: _t, triggerEvents: _e, ...analysis } = ast;
    return { ...analysis, stripped, name, file };
  }
  const analysis = analyzeApex(source, { projectObjects }, stripped);
  return {
    ...analysis,
    parser: "heuristic",
    parseErrors: ast.errors,
    name,
    invocable: /@InvocableMethod\b/i.test(stripped),
    isTest: /@isTest\b/i.test(stripped),
    file,
  };
}

const TRIGGER_HEADER = /\btrigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/i;

export function parseApexTrigger(
  source: string,
  fallbackName: string,
  file: string,
  projectObjects: Set<string>,
): ApexTriggerDef | undefined {
  const stripped = stripApex(source);
  const ast = analyzeApexAst(source, { projectObjects, kind: "trigger" });
  if (!("errors" in ast) && ast.triggerObject) {
    const { name, triggerObject, triggerEvents, invocable: _i, isTest: _t, ...analysis } = ast;
    return {
      ...analysis,
      stripped,
      name: name ?? fallbackName,
      object: triggerObject,
      events: triggerEvents ?? [],
      file,
    };
  }
  const header = stripped.match(TRIGGER_HEADER);
  if (!header) return undefined;
  const object = header[2]!;
  const events: { timing: Timing; event: SaveEvent }[] = [];
  for (const part of header[3]!.split(",")) {
    const m = part.trim().match(/^(before|after)\s+(insert|update|delete|undelete)$/i);
    if (m) events.push({ timing: m[1]!.toLowerCase() as Timing, event: m[2]!.toLowerCase() as SaveEvent });
  }
  // Blank the header so its event keywords are not mistaken for DML statements.
  const headerStart = header.index ?? 0;
  const body =
    stripped.slice(0, headerStart) + " ".repeat(header[0].length) + stripped.slice(headerStart + header[0].length);
  const analysis = analyzeApex(source, { projectObjects, triggerObject: object }, body);
  return {
    ...analysis,
    parser: "heuristic",
    parseErrors: "errors" in ast ? ast.errors : undefined,
    name: header[1] ?? fallbackName,
    object,
    events,
    file,
  };
}
