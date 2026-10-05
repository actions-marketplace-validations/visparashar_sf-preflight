// SPDX-License-Identifier: Apache-2.0
import type { FieldDef, OrgModel } from "../types.js";
import { key } from "../util.js";
import type { FValue, SolverContext } from "./solver.js";

/**
 * Static knowledge about standard objects that SFDX source doesn't contain. Custom fields come
 * from the project; for anything not listed here the generator stays conservative (the runtime
 * factory reads the real schema in the org).
 */

/** Required, createable standard fields that the runtime factory fills in. */
const STANDARD_REQUIRED: Record<string, string[]> = {
  account: ["Name"],
  asset: ["Name"],
  campaign: ["Name"],
  contact: ["LastName"],
  contract: ["AccountId"],
  lead: ["LastName", "Company"],
  opportunity: ["Name", "StageName", "CloseDate"],
  order: ["AccountId", "EffectiveDate", "Status"],
  pricebook2: ["Name"],
  product2: ["Name"],
};

/** Standard fields that get an org-specific default on create. */
const STANDARD_DEFAULTED: Record<string, string[]> = {
  case: ["Status", "Priority", "Origin"],
  contract: ["Status"],
  lead: ["Status"],
  opportunity: ["ForecastCategoryName"],
  task: ["Status", "Priority"],
};

/** Standard fields that can't be set directly (system, derived or compound). */
const NOT_SETTABLE = new Set(
  [
    "Id",
    "IsDeleted",
    "CreatedDate",
    "CreatedById",
    "LastModifiedDate",
    "LastModifiedById",
    "SystemModstamp",
    "LastActivityDate",
    "LastViewedDate",
    "LastReferencedDate",
    "MasterRecordId",
    "IsClosed",
    "IsWon",
    "IsConverted",
    "ConvertedDate",
    "ClosedDate",
    "ExpectedRevenue",
    "HasOpportunityLineItem",
    "ForecastCategory",
    "FiscalYear",
    "FiscalQuarter",
    "Fiscal",
    "IsPersonAccount",
  ].map(key),
);

/** Child object → parent object → lookup field on the child. "*" matches any parent. */
const STANDARD_RELATIONSHIPS: Record<string, Record<string, string>> = {
  account: { account: "ParentId" },
  asset: { account: "AccountId", contact: "ContactId" },
  case: { account: "AccountId", contact: "ContactId" },
  casecomment: { case: "ParentId" },
  contact: { account: "AccountId" },
  contract: { account: "AccountId" },
  event: { contact: "WhoId", lead: "WhoId", "*": "WhatId" },
  opportunity: { account: "AccountId" },
  opportunitycontactrole: { opportunity: "OpportunityId", contact: "ContactId" },
  opportunitylineitem: { opportunity: "OpportunityId" },
  order: { account: "AccountId", contract: "ContractId" },
  task: { contact: "WhoId", lead: "WhoId", "*": "WhatId" },
};

export function fieldDef(model: OrgModel, object: string, field: string): FieldDef | undefined {
  return model.objects.get(key(object))?.fields.get(key(field));
}

const isCustom = (field: string) => /__c$/i.test(field);

/** Can generated tests set this field? */
export function isSettable(model: OrgModel, object: string, field: string): boolean {
  if (field.includes(".") || field.startsWith("$")) return false;
  const def = fieldDef(model, object, field);
  if (def) return !def.formula && def.type !== "Summary" && def.type !== "AutoNumber";
  if (isCustom(field)) return false; // custom field we don't have the definition of
  return !NOT_SETTABLE.has(key(field));
}

/** The value a field has on a factory-built record when the test doesn't set it. */
export function defaultValue(model: OrgModel, object: string, field: string): FValue | undefined {
  const def = fieldDef(model, object, field);
  if (def) {
    if (def.formula || def.type === "Summary" || def.type === "AutoNumber") return undefined;
    if (def.type === "Checkbox") return { kind: "lit", value: def.defaultValue?.toLowerCase() === "true" };
    if (def.defaultValue !== undefined) return undefined;
    return def.required ? { kind: "any" } : { kind: "null" };
  }
  if (isCustom(field) || !isSettable(model, object, field)) return undefined;
  const o = key(object);
  if (STANDARD_REQUIRED[o]?.some((f) => key(f) === key(field))) return { kind: "any" };
  if (STANDARD_DEFAULTED[o]?.some((f) => key(f) === key(field))) return undefined;
  return { kind: "null" };
}

export function solverContext(
  model: OrgModel,
  object: string,
  event: "insert" | "update",
  /** Values the record already has (for updates), consulted before the defaults. */
  current?: Map<string, FValue>,
): SolverContext {
  return {
    event,
    settable: (field) => isSettable(model, object, field),
    defaultOf: (field) => current?.get(key(field)) ?? defaultValue(model, object, field),
  };
}

/** Lookup/master-detail field on `child` that points at `parent`. */
export function relationshipField(model: OrgModel, child: string, parent: string): string | undefined {
  const custom = [...(model.objects.get(key(child))?.fields.values() ?? [])].find((f) =>
    f.referenceTo.some((r) => key(r) === key(parent)),
  );
  if (custom) return custom.name;
  const std = STANDARD_RELATIONSHIPS[key(child)];
  return std?.[key(parent)] ?? (std?.["*"] && !["contact", "lead"].includes(key(parent)) ? std["*"] : undefined);
}
