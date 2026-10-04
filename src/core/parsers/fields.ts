// SPDX-License-Identifier: Apache-2.0
import type { FieldDef } from "../types.js";
import { asArray, nodes, parseMetadataXml, text, uniq } from "../util.js";
import { formulaFieldRefs } from "./formula.js";

/** Parse `objects/<Object>/fields/<Field>.field-meta.xml`. */
export function parseField(xml: string, object: string, fallbackName: string, file: string): FieldDef {
  const { body } = parseMetadataXml(xml);
  const name = text(body.fullName) ?? fallbackName;
  const type = text(body.type);
  const formula = text(body.formula);
  const referenceTo = asArray(body.referenceTo as string | string[]).map(String);

  const field: FieldDef = {
    object,
    name,
    fullName: `${object}.${name}`,
    type,
    formula,
    formulaRefs: formula ? formulaFieldRefs(formula) : [],
    referenceTo,
    file,
  };

  if (type === "Summary") {
    const foreignKey = text(body.summaryForeignKey) ?? "";
    const [childObject, relationshipField] = foreignKey.split(".");
    const summarized = text(body.summarizedField);
    if (childObject) {
      field.summary = {
        childObject,
        relationshipField: relationshipField ?? "",
        operation: text(body.summaryOperation),
        summarizedField: summarized,
        filterFields: uniq(
          nodes(body.summaryFilterItems)
            .map((f) => text(f.field))
            .filter((f): f is string => !!f),
        ),
      };
    }
  }

  return field;
}
