// SPDX-License-Identifier: Apache-2.0
import type { RecordTypeDef } from "../types.js";
import { bool, nodes, parseMetadataXml, text } from "../util.js";
import { decode } from "./fields.js";

/** Parse `objects/<Object>/recordTypes/<Name>.recordType-meta.xml`. */
export function parseRecordType(xml: string, object: string, fallbackName: string, file: string): RecordTypeDef {
  const { body } = parseMetadataXml(xml);
  const picklists: Record<string, string[]> = Object.create(null);
  for (const p of nodes(body.picklistValues)) {
    const field = text(p.picklist);
    if (!field) continue;
    picklists[field] = nodes(p.values)
      .map((v) => text(v.fullName))
      .filter((v): v is string => !!v)
      .map(decode);
  }
  return { object, name: text(body.fullName) ?? fallbackName, active: bool(body.active), picklists, file };
}
