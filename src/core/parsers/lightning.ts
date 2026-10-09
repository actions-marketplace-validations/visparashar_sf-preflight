// SPDX-License-Identifier: Apache-2.0
import type { LightningDef } from "../types.js";

/**
 * Lightning Web Component and Aura bundles, read from their source text (regular expressions:
 * the imports and tags that name other metadata are regular enough that a JavaScript parser would
 * add weight without finding more). Finds the Apex methods a component calls, the fields it
 * imports or names, the labels it uses and the components it embeds.
 */

export interface BundleFile {
  path: string;
  text: string;
}

const LWC_APEX = /@salesforce\/apex(?:Continuation)?\/(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;
const LWC_SCHEMA = /@salesforce\/schema\/([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/g;
const LABEL = /(?:@salesforce\/label\/|\$Label\.)(?:c\.)?([A-Za-z0-9_]+)/g;
const LWC_IMPORT_CHILD = /from\s+['"]c\/([A-Za-z0-9_]+)['"]/g;
const LWC_TAG = /<c-([a-z0-9-]+)/g;
const AURA_CONTROLLER = /\bcontroller\s*=\s*["'](?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)["']/;
const AURA_CHILD = /<c:([A-Za-z0-9_]+)/g;
const AURA_METHOD = /\.get\(\s*["']c\.([A-Za-z0-9_]+)["']\s*\)/g;
const FIELD_LITERAL = /["']([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)["']/g;

const camel = (kebab: string) => kebab.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function all(re: RegExp, text: string): RegExpExecArray[] {
  return [...text.matchAll(re)];
}

/** Is a file part of a bundle's source (not its tests or config)? */
export function isBundleSource(file: string): boolean {
  return (
    !/\/__tests__\//.test(file) && /\.(js|html|cmp|app|evt|intf|design|tokens)$/.test(file) && !/\.test\.js$/.test(file)
  );
}

/**
 * Parse one bundle. `isObject` says whether a name is an SObject, so string literals such as
 * 'Opportunity.Amount' are taken as fields and 'lightning.button' is not.
 */
export function parseLightningBundle(
  kind: "lwc" | "aura",
  name: string,
  mainFile: string,
  files: BundleFile[],
  isObject: (name: string) => boolean,
): LightningDef {
  const apex = new Map<string, { cls: string; method?: string }>();
  const fields = new Set<string>();
  const objects = new Set<string>();
  const labels = new Set<string>();
  const children = new Set<string>();

  const auraControllerMethods: string[] = [];
  for (const { text } of files) {
    for (const m of all(LABEL, text)) labels.add(m[1]!);
    for (const m of all(FIELD_LITERAL, text)) if (isObject(m[1]!)) fields.add(`${m[1]}.${m[2]}`);
    if (kind === "lwc") {
      for (const m of all(LWC_APEX, text)) apex.set(`${m[1]}.${m[2]}`.toLowerCase(), { cls: m[1]!, method: m[2]! });
      for (const m of all(LWC_SCHEMA, text)) {
        if (m[2]) fields.add(`${m[1]}.${m[2]}`);
        else objects.add(m[1]!);
      }
      for (const m of all(LWC_IMPORT_CHILD, text)) children.add(m[1]!);
      for (const m of all(LWC_TAG, text)) children.add(camel(m[1]!));
    } else {
      const controller = AURA_CONTROLLER.exec(text);
      if (controller) apex.set(controller[1]!.toLowerCase(), { cls: controller[1]! });
      for (const m of all(AURA_CHILD, text)) children.add(m[1]!);
      for (const m of all(AURA_METHOD, text)) auraControllerMethods.push(m[1]!);
    }
  }
  // Aura: component.get("c.save") calls `save` on the component's controller class.
  if (kind === "aura") {
    const controller = [...apex.values()][0];
    if (controller) {
      for (const method of auraControllerMethods)
        apex.set(`${controller.cls}.${method}`.toLowerCase(), { cls: controller.cls, method });
    }
  }
  children.delete(name);
  return {
    kind,
    name,
    file: mainFile,
    files: files.map((f) => f.path),
    apex: [...apex.values()],
    fields: [...fields],
    objects: [...objects],
    labels: [...labels],
    children: [...children],
  };
}
