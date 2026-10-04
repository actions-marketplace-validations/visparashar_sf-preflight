// SPDX-License-Identifier: Apache-2.0
/**
 * Extract field references from a Salesforce formula (validation rules, formula fields).
 *
 * Heuristic tokenizer: removes string literals and comments, collects identifiers that are
 * not function calls, keywords or global variables. Relationship paths (Account.Industry)
 * are kept whole.
 */
const KEYWORDS = new Set(["true", "false", "null", "and", "or", "not"]);

export function formulaFieldRefs(formula: string): string[] {
  const cleaned = formula
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  const refs = new Set<string>();
  const re = /\$?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
  for (const m of cleaned.matchAll(re)) {
    const token = m[0];
    const end = (m.index ?? 0) + token.length;
    if (token.startsWith("$")) continue; // $User, $Profile, $Setup ...
    const after = cleaned.slice(end).match(/^\s*\(/);
    if (after) continue; // function call
    if (KEYWORDS.has(token.toLowerCase())) continue;
    if (/^\d/.test(token)) continue;
    refs.add(token);
  }
  return [...refs];
}
