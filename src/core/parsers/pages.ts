// SPDX-License-Identifier: Apache-2.0
import type { FlexiPageDef, LayoutDef } from "../types.js";

/**
 * Page layouts and Lightning pages (flexipages), read as text: the parts that name other
 * metadata (`<field>`, `<componentName>`, `{!Record.Field}`) are simple tags, so a pattern
 * is enough and a malformed file still yields what it can.
 */

const FIELD_TAG = /<field>\s*([^<\s][^<]*?)\s*<\/field>/g;
const COMPONENT_NAME = /<componentName>\s*([^<\s][^<]*?)\s*<\/componentName>/g;
const SOBJECT_TYPE = /<sobjectType>\s*([^<\s][^<]*?)\s*<\/sobjectType>/;
const RECORD_FIELD = /\{!\s*Record\.([A-Za-z][A-Za-z0-9_]*)\s*\}/g;
const FIELD_ITEM = /<fieldItem>\s*Record\.([A-Za-z][A-Za-z0-9_]*)\s*<\/fieldItem>/g;

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const grab = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1] as string);

/** Parse `layouts/<Object>-<Layout name>.layout-meta.xml`. The object is the part before the first dash. */
export function parseLayout(xml: string, name: string, file: string): LayoutDef {
  const dash = name.indexOf("-");
  return { name, object: dash > 0 ? name.slice(0, dash) : name, fields: uniq(grab(FIELD_TAG, xml)), file };
}

/** Parse `flexipages/<Name>.flexipage-meta.xml`. Fields are `Object.Field` for record pages. */
export function parseFlexiPage(xml: string, name: string, file: string): FlexiPageDef {
  const object = SOBJECT_TYPE.exec(xml)?.[1];
  const fields = object
    ? uniq([...grab(RECORD_FIELD, xml), ...grab(FIELD_ITEM, xml)]).map((f) => `${object}.${f}`)
    : [];
  return { name, object, components: uniq(grab(COMPONENT_NAME, xml)), fields, file };
}

/** Does a component name on a page refer to a custom component, and which bundle name? */
export function customComponent(componentName: string): string | undefined {
  const i = componentName.indexOf(":");
  if (i < 0) return componentName; // a bare name is a component of the page's own namespace
  const ns = componentName.slice(0, i);
  return ns === "c" ? componentName.slice(i + 1) : undefined; // c:name; other prefixes are standard or managed
}
