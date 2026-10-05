// SPDX-License-Identifier: Apache-2.0
import { key } from "../util.js";

/**
 * A small constraint solver for Salesforce validation-rule formulas.
 *
 * Generated tests need records that pass the org's validation rules, while still setting the
 * fields a test is about (a flow's entry criteria, a changed field). For each rule we look for
 * field values that make its error condition FALSE, changing only fields that are free.
 *
 * Supported: AND/OR/NOT/IF, && || !, ISBLANK, ISNULL, ISPICKVAL, TEXT, BLANKVALUE, ISNEW,
 * ISCHANGED (insert only), = == <> != < > <= >= against literals, checkbox fields. Anything
 * else (relationship paths, $User, PRIORVALUE, functions we don't model) is "unknown": the
 * solver works around it when another part of the formula can be made false, and otherwise
 * reports the rule as unsolved so the generated test says so.
 */

export type FValue =
  | { kind: "null" }
  | { kind: "any" }
  | { kind: "lit"; value: string | number | boolean }
  | { kind: "not"; value: string };

/** Lower-case field name → value. Original spelling is kept in `names`. */
export interface Assignment {
  values: Map<string, FValue>;
  names: Map<string, string>;
}

export interface SolverContext {
  event: "insert" | "update";
  /** Can the solver set this field (not formula, not system, no relationship path)? */
  settable(field: string): boolean;
  /** Value a field has when the solver doesn't set it; undefined = unknown. */
  defaultOf(field: string): FValue | undefined;
}

export function emptyAssignment(): Assignment {
  return { values: new Map(), names: new Map() };
}

export function assign(a: Assignment, field: string, value: FValue): Assignment {
  const values = new Map(a.values);
  const names = new Map(a.names);
  values.set(key(field), value);
  if (!names.has(key(field))) names.set(key(field), field);
  return { values, names };
}

// ----------------------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------------------

export type Expr =
  | { t: "lit"; value: string | number | boolean | null }
  | { t: "field"; name: string }
  | { t: "call"; name: string; args: Expr[] }
  | { t: "bin"; op: string; left: Expr; right: Expr }
  | { t: "not"; arg: Expr }
  | { t: "neg"; arg: Expr };

interface Token {
  k: "num" | "str" | "id" | "op";
  v: string;
}

const OPS = ["<=", ">=", "<>", "!=", "==", "&&", "||", "=", "<", ">", "!", "+", "-", "*", "/", "&", "^", "(", ")", ","];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          v += src[j + 1];
          j += 2;
        } else {
          v += src[j++];
        }
      }
      if (j >= src.length) throw new Error("Unterminated string");
      out.push({ k: "str", v });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^\$?[A-Za-z_][A-Za-z0-9_]*(\.\$?[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`Unexpected character ${JSON.stringify(c)}`);
    out.push({ k: "op", v: op });
    i += op.length;
  }
  return out;
}

export function parseFormula(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops: string[]) => peek()?.k === "op" && ops.includes(peek()!.v);
  const expectOp = (op: string) => {
    if (!isOp(op)) throw new Error(`Expected ${op}`);
    pos++;
  };
  const binary = (next: () => Expr, ops: string[]) => (): Expr => {
    let left = next();
    while (isOp(...ops)) {
      const op = tokens[pos++]!.v;
      left = { t: "bin", op, left, right: next() };
    }
    return left;
  };
  const primary = (): Expr => {
    const tok = tokens[pos++];
    if (!tok) throw new Error("Unexpected end of formula");
    if (tok.k === "num") return { t: "lit", value: Number(tok.v) };
    if (tok.k === "str") return { t: "lit", value: tok.v };
    if (tok.k === "op" && tok.v === "(") {
      const e = expr();
      expectOp(")");
      return e;
    }
    if (tok.k === "id") {
      const upper = tok.v.toUpperCase();
      if (isOp("(")) {
        pos++;
        const args: Expr[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            pos++;
            args.push(expr());
          }
        }
        expectOp(")");
        return { t: "call", name: upper, args };
      }
      if (upper === "TRUE") return { t: "lit", value: true };
      if (upper === "FALSE") return { t: "lit", value: false };
      if (upper === "NULL") return { t: "lit", value: null };
      return { t: "field", name: tok.v };
    }
    throw new Error(`Unexpected ${tok.v}`);
  };
  const unary = (): Expr => {
    if (isOp("!")) {
      pos++;
      return { t: "not", arg: unary() };
    }
    if (isOp("-")) {
      pos++;
      return { t: "neg", arg: unary() };
    }
    return primary();
  };
  const power = binary(unary, ["^"]);
  const mul = binary(power, ["*", "/"]);
  const add = binary(mul, ["+", "-", "&"]);
  const cmp = binary(add, ["=", "==", "<>", "!=", "<", ">", "<=", ">="]);
  const and = binary(cmp, ["&&"]);
  const expr = binary(and, ["||"]);
  const result = expr();
  if (pos < tokens.length) throw new Error(`Unexpected ${tokens[pos]!.v}`);
  return result;
}

// ----------------------------------------------------------------------------------------
// Three-valued evaluation
// ----------------------------------------------------------------------------------------

type Val = FValue | { kind: "unknown" };
const UNKNOWN: Val = { kind: "unknown" };

const isSimpleField = (e: Expr): e is { t: "field"; name: string } =>
  e.t === "field" && !e.name.includes(".") && !e.name.startsWith("$");

function valueIn(e: Expr, a: Assignment, ctx: SolverContext): Val {
  if (e.t === "lit") return e.value === null ? { kind: "null" } : { kind: "lit", value: e.value };
  if (isSimpleField(e)) return a.values.get(key(e.name)) ?? ctx.defaultOf(e.name) ?? UNKNOWN;
  if (e.t === "call" && e.name === "TEXT" && e.args.length === 1) return valueIn(e.args[0]!, a, ctx);
  if (e.t === "call" && e.name === "BLANKVALUE" && e.args.length === 2) {
    const v = valueIn(e.args[0]!, a, ctx);
    if (v.kind === "null") return valueIn(e.args[1]!, a, ctx);
    return v.kind === "unknown" ? UNKNOWN : v;
  }
  return UNKNOWN;
}

function isBlank(v: Val): boolean | undefined {
  if (v.kind === "null") return true;
  if (v.kind === "lit") return v.value === "";
  if (v.kind === "any" || v.kind === "not") return false;
  return undefined;
}

function equals(x: Val, y: Val): boolean | undefined {
  if (x.kind === "unknown" || y.kind === "unknown") return undefined;
  if (x.kind === "null" || y.kind === "null") return x.kind === y.kind ? true : isBlank(x.kind === "null" ? y : x);
  if (x.kind === "lit" && y.kind === "lit") return x.value === y.value;
  const notSide = x.kind === "not" ? x : y.kind === "not" ? y : undefined;
  const litSide = x.kind === "lit" ? x : y.kind === "lit" ? y : undefined;
  if (notSide && litSide && String(litSide.value) === notSide.value) return false;
  return undefined;
}

const NOT = (b: boolean | undefined) => (b === undefined ? undefined : !b);

function children(e: Expr, fn: "AND" | "OR"): Expr[] | undefined {
  if (e.t === "call" && e.name === fn) return e.args;
  if (e.t === "bin" && e.op === (fn === "AND" ? "&&" : "||")) return [e.left, e.right];
  return undefined;
}

export function evaluate(e: Expr, a: Assignment, ctx: SolverContext): boolean | undefined {
  const and = children(e, "AND");
  if (and) {
    const r = and.map((c) => evaluate(c, a, ctx));
    return r.includes(false) ? false : r.every((x) => x === true) ? true : undefined;
  }
  const or = children(e, "OR");
  if (or) {
    const r = or.map((c) => evaluate(c, a, ctx));
    return r.includes(true) ? true : r.every((x) => x === false) ? false : undefined;
  }
  if (e.t === "not") return NOT(evaluate(e.arg, a, ctx));
  if (e.t === "lit") return typeof e.value === "boolean" ? e.value : undefined;
  if (e.t === "field") {
    const v = valueIn(e, a, ctx);
    if (v.kind === "lit" && typeof v.value === "boolean") return v.value;
    if (v.kind === "null") return false;
    return undefined;
  }
  if (e.t === "call") {
    const [x, y, z] = e.args;
    switch (e.name) {
      case "NOT":
        return x ? NOT(evaluate(x, a, ctx)) : undefined;
      case "ISBLANK":
      case "ISNULL":
        return x ? isBlank(valueIn(x, a, ctx)) : undefined;
      case "ISPICKVAL":
        return x && y ? equals(valueIn(x, a, ctx), valueIn(y, a, ctx)) : undefined;
      case "ISNEW":
        return ctx.event === "insert";
      case "ISCHANGED":
        return ctx.event === "insert" ? false : undefined;
      case "IF": {
        if (!x || !y || !z) return undefined;
        const c = evaluate(x, a, ctx);
        if (c === undefined) {
          const l = evaluate(y, a, ctx);
          return l !== undefined && l === evaluate(z, a, ctx) ? l : undefined;
        }
        return evaluate(c ? y : z, a, ctx);
      }
      default:
        return undefined;
    }
  }
  if (e.t === "bin") {
    const l = valueIn(e.left, a, ctx);
    const r = valueIn(e.right, a, ctx);
    switch (e.op) {
      case "=":
      case "==":
        return equals(l, r);
      case "<>":
      case "!=":
        return NOT(equals(l, r));
      case "<":
      case ">":
      case "<=":
      case ">=": {
        if (l.kind !== "lit" || r.kind !== "lit" || typeof l.value !== "number" || typeof r.value !== "number") {
          return undefined;
        }
        const [p, q] = [l.value, r.value];
        return e.op === "<" ? p < q : e.op === ">" ? p > q : e.op === "<=" ? p <= q : p >= q;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

// ----------------------------------------------------------------------------------------
// Solving
// ----------------------------------------------------------------------------------------

/**
 * Return an assignment (extending `a`) under which `e` evaluates to `want`, or undefined.
 * Fields already present in `a` are never changed: they're the test's intent or earlier choices.
 */
export function achieve(e: Expr, want: boolean, a: Assignment, ctx: SolverContext): Assignment | undefined {
  if (evaluate(e, a, ctx) === want) return a;
  const set = (field: string, value: FValue): Assignment | undefined => {
    if (a.values.has(key(field)) || !ctx.settable(field)) return undefined;
    const next = assign(a, field, value);
    return evaluate(e, next, ctx) === want ? next : undefined;
  };

  const and = children(e, "AND");
  const or = children(e, "OR");
  if (and || or) {
    const list = (and ?? or)!;
    // AND false / OR true: one child is enough. AND true / OR false: all children.
    const one = (and && !want) || (or && want);
    if (one) {
      for (const c of list) {
        const r = achieve(c, want, a, ctx);
        if (r && evaluate(e, r, ctx) === want) return r;
      }
      return undefined;
    }
    let acc: Assignment | undefined = a;
    for (const c of list) {
      acc = acc && achieve(c, want, acc, ctx);
      if (!acc) return undefined;
    }
    return evaluate(e, acc, ctx) === want ? acc : undefined;
  }
  if (e.t === "not") return achieve(e.arg, !want, a, ctx);
  if (e.t === "field" && isSimpleField(e)) return set(e.name, { kind: "lit", value: want });
  if (e.t === "call") {
    const [x, y, z] = e.args;
    if (e.name === "NOT" && x) return achieve(x, !want, a, ctx);
    if ((e.name === "ISBLANK" || e.name === "ISNULL") && x && isSimpleField(x)) {
      return set(x.name, want ? { kind: "null" } : { kind: "any" });
    }
    if (e.name === "ISPICKVAL" && x && isSimpleField(x) && y?.t === "lit" && typeof y.value === "string") {
      return set(x.name, want ? { kind: "lit", value: y.value } : { kind: "not", value: y.value });
    }
    if (e.name === "IF" && x && y && z) {
      for (const [cond, branch] of [
        [true, y],
        [false, z],
      ] as const) {
        const c = achieve(x, cond, a, ctx);
        const r = c && achieve(branch, want, c, ctx);
        if (r && evaluate(e, r, ctx) === want) return r;
      }
    }
    return undefined;
  }
  if (e.t === "bin") {
    const [fieldSide, litSide] = isSimpleField(e.left) ? [e.left, e.right] : [e.right, e.left];
    if (!isSimpleField(fieldSide) || litSide.t !== "lit") return undefined;
    const lit = litSide.value;
    const flip = fieldSide === e.right; // "5 < X" is "X > 5"
    let op = e.op;
    if (flip) op = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" }[op] ?? op;
    if (op === "<>" || op === "!=") return achieve({ ...e, op: "=" }, !want, a, ctx);
    if (op === "=" || op === "==") {
      if (want) return set(fieldSide.name, lit === null ? { kind: "null" } : { kind: "lit", value: lit });
      if (lit === null) return set(fieldSide.name, { kind: "any" });
      if (typeof lit === "number") return set(fieldSide.name, { kind: "lit", value: lit + 1 });
      if (typeof lit === "boolean") return set(fieldSide.name, { kind: "lit", value: !lit });
      return set(fieldSide.name, { kind: "not", value: lit });
    }
    if (typeof lit === "number") {
      const truth: Record<string, [number, number]> = {
        // op: [value making it true, value making it false]
        "<": [lit - 1, lit],
        ">": [lit + 1, lit],
        "<=": [lit, lit + 1],
        ">=": [lit, lit - 1],
      };
      const pair = truth[op];
      if (pair) return set(fieldSide.name, { kind: "lit", value: want ? pair[0] : pair[1] });
    }
  }
  return undefined;
}

export interface RuleInput {
  name: string;
  formula: string;
}

export interface SolveResult {
  assignment: Assignment;
  /** Rules whose error condition could not be shown to be false with the chosen values. */
  unsolved: { name: string; reason: string }[];
}

/** Choose values so every rule's error condition is false, keeping `initial` unchanged. */
export function solveRules(
  rules: RuleInput[],
  ctx: SolverContext,
  initial: Assignment = emptyAssignment(),
): SolveResult {
  let a = initial;
  const parsed: { name: string; expr?: Expr; error?: string }[] = rules.map((r) => {
    try {
      return { name: r.name, expr: parseFormula(r.formula) };
    } catch (err) {
      return { name: r.name, error: (err as Error).message };
    }
  });
  for (const p of parsed) {
    if (!p.expr) continue;
    const next = achieve(p.expr, false, a, ctx);
    if (next) a = next;
  }
  const unsolved = parsed
    .filter((p) => !p.expr || evaluate(p.expr, a, ctx) !== false)
    .map((p) => ({
      name: p.name,
      reason: p.error
        ? `formula not understood (${p.error})`
        : evaluate(p.expr!, a, ctx) === true
          ? "the values this test needs violate it"
          : "uses functions or fields the generator can't control",
    }));
  return { assignment: a, unsolved };
}
