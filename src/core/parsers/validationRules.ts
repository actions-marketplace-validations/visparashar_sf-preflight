// SPDX-License-Identifier: Apache-2.0
import type { ValidationRuleDef } from "../types.js";
import { bool, parseMetadataXml, text } from "../util.js";
import { formulaFieldRefs } from "./formula.js";

/** Parse `objects/<Object>/validationRules/<Rule>.validationRule-meta.xml`. */
export function parseValidationRule(
  xml: string,
  object: string,
  fallbackName: string,
  file: string,
): ValidationRuleDef {
  const { body } = parseMetadataXml(xml);
  const name = text(body.fullName) ?? fallbackName;
  const formula = text(body.errorConditionFormula) ?? "";
  return {
    object,
    name,
    fullName: `${object}.${name}`,
    active: bool(body.active),
    formula,
    errorMessage: text(body.errorMessage),
    fieldRefs: formulaFieldRefs(formula),
    file,
  };
}
