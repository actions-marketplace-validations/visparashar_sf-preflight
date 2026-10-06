// SPDX-License-Identifier: Apache-2.0
import type { OrgModel } from "../types.js";
import { key } from "../util.js";

/**
 * Reduces production error messages to what they say about metadata: the kind of failure, the
 * exception type and status code, the validation rule whose message it is, and the fields it
 * names. Messages themselves often contain record data (names, amounts, IDs, emails), so they are
 * read here and never kept: everything returned is either a fixed label or a name that exists in
 * the project or the change history.
 */

export type ErrorCategory =
  | "validation"
  | "required-field"
  | "invalid-field"
  | "soql-limit"
  | "dml-limit"
  | "cpu-limit"
  | "heap-limit"
  | "recursion"
  | "null-pointer"
  | "no-rows"
  | "list-index"
  | "access"
  | "duplicate"
  | "row-lock"
  | "string-too-long"
  | "field-filter"
  | "callout"
  | "dml"
  | "other";

export const CATEGORY_LABEL: Record<ErrorCategory, string> = {
  validation: "A validation rule blocked a save",
  "required-field": "A required field was missing",
  "invalid-field": "A field doesn't exist or can't be used",
  "soql-limit": "Too many SOQL queries",
  "dml-limit": "Too many DML statements",
  "cpu-limit": "Apex CPU time limit exceeded",
  "heap-limit": "Apex heap size too large",
  recursion: "Maximum trigger depth exceeded (recursion)",
  "null-pointer": "Null reference",
  "no-rows": "A query returned no rows",
  "list-index": "List index out of bounds",
  access: "Insufficient access",
  duplicate: "Duplicate value",
  "row-lock": "Record lock contention",
  "string-too-long": "A value was too long for its field",
  "field-filter": "A lookup filter blocked a save",
  callout: "Callout failed",
  dml: "A save failed",
  other: "Error",
};

/** Preflight rules whose findings predict each kind of failure. */
export const CATEGORY_RULES: Record<ErrorCategory, string[]> = {
  validation: [
    "automated-write-vs-validation-rule",
    "validation-rule-vs-existing-automation",
    "field-used-by-validation-rule",
  ],
  "required-field": ["automated-write-vs-validation-rule"],
  "invalid-field": ["deleted-still-referenced", "agent-action-target-missing"],
  "soql-limit": ["dml-or-soql-in-loop", "recursion-cycle", "automation-density"],
  "dml-limit": ["dml-or-soql-in-loop", "recursion-cycle", "automation-density"],
  "cpu-limit": ["recursion-cycle", "after-save-self-update", "automation-density", "dml-or-soql-in-loop"],
  "heap-limit": ["dml-or-soql-in-loop"],
  recursion: ["recursion-cycle", "after-save-self-update"],
  "null-pointer": [],
  "no-rows": [],
  "list-index": [],
  access: [
    "agent-runtime-access",
    "permission-delete",
    "permission-field-edit",
    "permission-escalation",
    "permission-system",
  ],
  duplicate: [],
  "row-lock": ["automation-density", "multiple-triggers"],
  "string-too-long": [],
  "field-filter": [],
  callout: [],
  dml: ["automated-write-vs-validation-rule", "validation-rule-vs-existing-automation"],
  other: [],
};

const PATTERNS: [ErrorCategory, RegExp][] = [
  ["recursion", /maximum trigger depth exceeded/i],
  ["soql-limit", /too many soql queries/i],
  ["dml-limit", /too many dml (?:statements|rows)/i],
  ["cpu-limit", /apex cpu time limit exceeded/i],
  ["heap-limit", /heap size too large/i],
  ["validation", /FIELD_CUSTOM_VALIDATION_EXCEPTION/],
  ["required-field", /REQUIRED_FIELD_MISSING/],
  [
    "invalid-field",
    /INVALID_FIELD|FIELD_NOT_UPDATEABLE|no such column|invalid field|without querying the requested field/i,
  ],
  ["access", /INSUFFICIENT_ACCESS|insufficient access rights|NoAccessException/i],
  ["duplicate", /DUPLICATE_VALUE|DUPLICATES_DETECTED/],
  ["row-lock", /UNABLE_TO_LOCK_ROW/],
  ["string-too-long", /STRING_TOO_LONG|data value too large/i],
  ["field-filter", /FIELD_FILTER_VALIDATION_EXCEPTION/],
  ["null-pointer", /NullPointerException|de-reference a null object/i],
  ["no-rows", /list has no rows for assignment/i],
  ["list-index", /list index out of bounds/i],
  ["callout", /CalloutException|uncommitted work pending/i],
];

/** Salesforce status codes worth reporting; other upper-case words could be record data. */
const STATUS_CODES = new Set([
  "APEX_ERROR",
  "CANNOT_EXECUTE_FLOW_TRIGGER",
  "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
  "CANNOT_UPDATE_CONVERTED_LEAD",
  "CIRCULAR_DEPENDENCY",
  "DELETE_FAILED",
  "DEPENDENCY_EXISTS",
  "DUPLICATES_DETECTED",
  "DUPLICATE_VALUE",
  "ENTITY_IS_DELETED",
  "ENTITY_IS_LOCKED",
  "FIELD_CUSTOM_VALIDATION_EXCEPTION",
  "FIELD_FILTER_VALIDATION_EXCEPTION",
  "FIELD_INTEGRITY_EXCEPTION",
  "FIELD_NOT_UPDATEABLE",
  "INACTIVE_OWNER_OR_USER",
  "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY",
  "INSUFFICIENT_ACCESS_OR_READONLY",
  "INVALID_CROSS_REFERENCE_KEY",
  "INVALID_EMAIL_ADDRESS",
  "INVALID_FIELD",
  "INVALID_FIELD_FOR_INSERT_UPDATE",
  "INVALID_ID_FIELD",
  "INVALID_OPERATION",
  "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST",
  "INVALID_STATUS",
  "INVALID_TYPE_ON_FIELD_IN_RECORD",
  "LIMIT_EXCEEDED",
  "MALFORMED_ID",
  "MISSING_ARGUMENT",
  "NUMBER_OUTSIDE_VALID_RANGE",
  "REQUEST_RUNNING_TOO_LONG",
  "REQUIRED_FIELD_MISSING",
  "STORAGE_LIMIT_EXCEEDED",
  "STRING_TOO_LONG",
  "TRANSFER_REQUIREMENT_ERROR",
  "UNABLE_TO_LOCK_ROW",
  "UNKNOWN_EXCEPTION",
]);

/** What an error message says, reduced to metadata. Never the message itself. */
export interface ErrorSignature {
  category: ErrorCategory;
  /** Exception type, e.g. "System.DmlException". */
  exceptionType?: string;
  /** Salesforce status code, e.g. "FIELD_CUSTOM_VALIDATION_EXCEPTION" (the innermost one). */
  statusCode?: string;
  /**
   * Validation rules ("Object.Rule") whose error message the error is. Usually one; several when
   * rules share a message.
   */
  validationRules: string[];
  /** Known fields the message names ("Object.Field" when the object is known). */
  fields: string[];
  /** Known Apex triggers the message names, e.g. "ContactTrigger: execution of AfterUpdate". */
  triggers: string[];
}

/** Validation rule messages and field names the classifier may recognise. */
export interface ErrorVocabulary {
  validationRules: { name: string; message: string }[];
  /** Field API names: "Object.Field". */
  fields: string[];
  triggers: string[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The vocabulary of the project as it is now; the change history adds what was renamed or deleted. */
export function vocabularyFromModel(model: OrgModel): ErrorVocabulary {
  return {
    validationRules: model.validationRules
      .filter((v) => v.errorMessage?.trim())
      .map((v) => ({ name: v.fullName, message: v.errorMessage! })),
    fields: [...model.objects.values()].flatMap((o) => [...o.fields.values()].map((f) => `${o.name}.${f.name}`)),
    triggers: [...model.triggers.values()].map((t) => t.name),
  };
}

export function mergeVocabulary(a: ErrorVocabulary, b: Partial<ErrorVocabulary>): ErrorVocabulary {
  const byKey = <T>(items: T[], k: (t: T) => string) => [...new Map(items.map((i) => [k(i), i])).values()];
  return {
    validationRules: byKey(
      [...a.validationRules, ...(b.validationRules ?? [])],
      (v) => `${key(v.name)}|${norm(v.message)}`,
    ),
    fields: byKey([...a.fields, ...(b.fields ?? [])], key),
    triggers: byKey([...a.triggers, ...(b.triggers ?? [])], key),
  };
}

const EXCEPTION_TYPE = /\b((?:System|[A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*Exception)\b/;
const IDENT = /[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?/g;

const CUSTOM_VALIDATION = "field_custom_validation_exception";

/**
 * Validation rules whose message follows FIELD_CUSTOM_VALIDATION_EXCEPTION in the text. The message
 * must be the whole message: followed by the end, by ": [fields]" or ". You can look up…", or, when
 * it ends a sentence itself, by more text. A rule whose message is a prefix of another matching
 * rule's message is dropped.
 */
function ruleMessagesIn(text: string, vocab: ErrorVocabulary): string[] {
  const lower = norm(text);
  const found = new Map<string, string>();
  for (let i = lower.indexOf(CUSTOM_VALIDATION); i !== -1; i = lower.indexOf(CUSTOM_VALIDATION, i + 1)) {
    const rest = lower
      .slice(i + CUSTOM_VALIDATION.length, i + CUSTOM_VALIDATION.length + 2000)
      .replace(/^\s?[,:]\s?/, "");
    for (const v of vocab.validationRules) {
      const m = norm(v.message);
      if (!m || !rest.startsWith(m)) continue;
      const after = rest.slice(m.length);
      const sentence = /[.!?]$/.test(m) && (after === "" || after[0] === " ");
      if (sentence || after === "" || /^\s?[:;.)\]]/.test(after)) found.set(v.name, m);
    }
  }
  const messages = [...found.values()];
  return [...found]
    .filter(([, m]) => !messages.some((o) => o !== m && o.length > m.length && o.startsWith(m)))
    .map(([name]) => name)
    .sort();
}

/** Classify an error message. The message is only read, never returned. */
export function classifyError(
  message: string | undefined,
  vocab: ErrorVocabulary,
  exceptionType?: string,
): ErrorSignature {
  const text = (message ?? "").slice(0, 20_000);
  const category = PATTERNS.find(([, re]) => re.test(text))?.[0] ?? "other";

  const codes = [...text.matchAll(/\b[A-Z][A-Z_]{4,}[A-Z]\b/g)].map((m) => m[0]).filter((c) => STATUS_CODES.has(c));
  // The wrapper code (e.g. CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY) comes first; the cause comes last.
  const statusCode = codes.filter((c) => c !== "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY").at(-1) ?? codes.at(-1);

  const type = [exceptionType, EXCEPTION_TYPE.exec(text)?.[1]].find(
    (t): t is string => !!t && /^[A-Za-z_][A-Za-z0-9_.]{0,120}Exception$/.test(t),
  );

  const validationRules = ruleMessagesIn(text, vocab);

  // Field names: qualified names and custom fields anywhere, bare names only in "[A, B]" lists or
  // quoted after "column" (where Salesforce puts them). Only names the project knows are kept.
  const known = new Map<string, string>();
  const byField = new Map<string, string[]>();
  for (const f of vocab.fields) {
    known.set(key(f), f);
    const bare = key(f.split(".").at(-1)!);
    byField.set(bare, [...(byField.get(bare) ?? []), f]);
  }
  const fields = new Set<string>();
  const addBare = (name: string, objectHint?: string) => {
    const options = byField.get(key(name)) ?? [];
    const hinted = objectHint ? options.find((f) => key(f.split(".")[0]!) === key(objectHint)) : undefined;
    if (hinted) fields.add(hinted);
    else if (options.length === 1) fields.add(options[0]!);
  };
  for (const m of text.matchAll(IDENT)) {
    const tok = m[0];
    if (tok.includes(".")) {
      const hit = known.get(key(tok));
      if (hit) fields.add(hit);
    } else if (/__(?:c|pc)$/i.test(tok)) addBare(tok);
  }
  for (const m of text.matchAll(/\[([A-Za-z0-9_, ]{1,400})\]/g)) {
    for (const name of m[1]!.split(",").map((s) => s.trim())) if (name) addBare(name);
  }
  for (const m of text.matchAll(/no such column '([A-Za-z0-9_]+)' on entity '([A-Za-z0-9_]+)'/gi)) {
    addBare(m[1]!, m[2]);
  }
  for (const m of text.matchAll(/invalid field ([A-Za-z0-9_]+) for ([A-Za-z0-9_]+)/gi)) addBare(m[1]!, m[2]);

  const triggerNames = new Map(vocab.triggers.map((t) => [key(t), t]));
  const triggers = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*): execution of (?:Before|After)/g)) {
    const t = triggerNames.get(key(m[1]!));
    if (t) triggers.add(t);
  }

  return {
    category,
    ...(type ? { exceptionType: type } : {}),
    ...(statusCode ? { statusCode } : {}),
    validationRules,
    fields: [...fields].sort(),
    triggers: [...triggers].sort(),
  };
}

/** One line describing a signature, e.g. "A validation rule blocked a save (`Opportunity.X`)". */
export function describeSignature(s: ErrorSignature): string {
  const parts = [CATEGORY_LABEL[s.category]];
  const details: string[] = [];
  const rules = s.validationRules.map((r) => `\`${r}\``);
  if (rules.length === 1) details.push(`validation rule ${rules[0]}`);
  else if (rules.length) details.push(`one of validation rules ${rules.join(", ")}`);
  if (s.fields.length) details.push(s.fields.map((f) => `\`${f}\``).join(", "));
  const code = s.statusCode ?? s.exceptionType;
  if (code && !(s.category === "validation" && rules.length)) details.push(code);
  if (details.length) parts.push(`(${details.join("; ")})`);
  return parts.join(" ");
}
