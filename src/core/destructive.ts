// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { METADATA_BY_SUFFIX, METADATA_DIR_BY_SUFFIX } from "./metadataTypes.js";
import { classifyPath } from "./project.js";
import type { Change, ChangeType } from "./types.js";

/**
 * Destructive manifests (`destructiveChanges.xml`, `destructiveChangesPre.xml`,
 * `destructiveChangesPost.xml`) delete components from the org without deleting a source file.
 * Each member they list is turned into a deleted component, so it gets the same checks as a
 * deleted file: who still references it.
 */

export const DESTRUCTIVE_MANIFEST = /(?:^|\/)destructiveChanges(?:Pre|Post)?\.xml$/i;

/** Object child types: their folder and file suffix under `objects/<Object>/`. */
const CHILD: Record<string, [string, string]> = {
  CustomField: ["fields", "field"],
  ValidationRule: ["validationRules", "validationRule"],
  RecordType: ["recordTypes", "recordType"],
  ListView: ["listViews", "listView"],
  FieldSet: ["fieldSets", "fieldSet"],
  WebLink: ["webLinks", "webLink"],
  CompactLayout: ["compactLayouts", "compactLayout"],
  BusinessProcess: ["businessProcesses", "businessProcess"],
  SharingReason: ["sharingReasons", "sharingReason"],
  Index: ["indexes", "index"],
};

/** Metadata type → [folder, suffix], from the registry. The first suffix listed wins. */
const BY_TYPE = new Map<string, [string, string]>();
for (const [suffix, type] of Object.entries(METADATA_BY_SUFFIX)) {
  const dir = METADATA_DIR_BY_SUFFIX[suffix];
  if (dir && !BY_TYPE.has(type)) BY_TYPE.set(type, [dir, suffix]);
}

/** `<types><members>A</members><name>ApexClass</name></types>` → [{ type, member }]. Wildcards are skipped. */
export function parseDestructiveManifest(xml: string): { type: string; member: string }[] {
  const out: { type: string; member: string }[] = [];
  for (const block of xml.matchAll(/<types>([\s\S]*?)<\/types>/g)) {
    const body = block[1] ?? "";
    const type = body.match(/<name>\s*([^<\s]+)\s*<\/name>/)?.[1];
    if (!type) continue;
    for (const m of body.matchAll(/<members>\s*([^<]+?)\s*<\/members>/g)) {
      const member = m[1] ?? "";
      if (member && member !== "*" && !member.includes("..")) out.push({ type, member });
    }
  }
  return out;
}

/** The source path a component would have, so it is named and typed like any other change. */
export function sourcePathFor(type: string, member: string, root = "force-app/main/default"): string | undefined {
  const child = CHILD[type];
  if (child) {
    const dot = member.indexOf(".");
    if (dot <= 0) return undefined;
    return `${root}/objects/${member.slice(0, dot)}/${child[0]}/${member.slice(dot + 1)}.${child[1]}-meta.xml`;
  }
  if (type === "CustomObject") return `${root}/objects/${member}/${member}.object-meta.xml`;
  if (type === "LightningComponentBundle") return `${root}/lwc/${member}/${member}.js-meta.xml`;
  if (type === "AuraDefinitionBundle") return `${root}/aura/${member}/${member}.cmp-meta.xml`;
  if (type === "ApexClass") return `${root}/classes/${member}.cls`;
  if (type === "ApexTrigger") return `${root}/triggers/${member}.trigger`;
  const known = BY_TYPE.get(type);
  if (!known) return undefined;
  return `${root}/${known[0]}/${member}.${known[1]}-meta.xml`;
}

/**
 * Deleted components listed by the changed destructive manifests among `files`. Each component
 * gets the source path it would have (so it is typed like a deleted file); `manifestOf` maps that
 * path back to the manifest, for the report.
 */
export function destructiveChanges(
  projectDir: string,
  files: { file: string; changeType: ChangeType }[],
): { changes: Change[]; warnings: string[]; manifestOf: Map<string, string> } {
  const changes: Change[] = [];
  const warnings: string[] = [];
  const manifestOf = new Map<string, string>();
  for (const f of files) {
    if (f.changeType === "deleted" || !DESTRUCTIVE_MANIFEST.test(f.file)) continue;
    let xml: string;
    try {
      xml = readFileSync(path.join(projectDir, f.file), "utf8");
    } catch {
      continue;
    }
    const unknown = new Set<string>();
    for (const { type, member } of parseDestructiveManifest(xml)) {
      const synthetic = sourcePathFor(type, member);
      const component = synthetic ? classifyPath(synthetic) : undefined;
      if (!component || component.type === "Other") {
        unknown.add(type);
        continue;
      }
      changes.push({ changeType: "deleted", component, manifest: f.file });
      manifestOf.set(component.file, f.file);
    }
    if (unknown.size)
      warnings.push(`${f.file}: deletions of ${[...unknown].sort().join(", ")} are not checked (type not recognized).`);
  }
  return { changes, warnings, manifestOf };
}
