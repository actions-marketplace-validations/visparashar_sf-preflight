// SPDX-License-Identifier: Apache-2.0
import { parseApexClass, parseApexTrigger } from "./parsers/apex.js";

/**
 * Parse one Apex file into the value the parse cache stores: the definition without `stripped`
 * (rebuilt from the source), `name` and `file` (known to the caller). A trigger file with no
 * trigger header gives `{}`. Used by the loader and by the parallel parse workers, so both
 * produce the same value.
 */
export function parseApexUnit(
  kind: "class" | "trigger",
  source: string,
  name: string,
  file: string,
  projectObjects: Set<string>,
): object {
  if (kind === "class") {
    const { stripped: _s, name: _n, file: _f, ...rest } = parseApexClass(source, name, file, projectObjects);
    return rest;
  }
  const trig = parseApexTrigger(source, name, file, projectObjects);
  if (!trig) return {};
  const { stripped: _s, file: _f, ...rest } = trig;
  return { def: rest };
}
