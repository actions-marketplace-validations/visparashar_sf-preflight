import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ComponentRef, ObjectDef, OrgModel } from "./types.js";
import { key, toPosix } from "./util.js";
import { parseField } from "./parsers/fields.js";
import { parseValidationRule } from "./parsers/validationRules.js";
import { parseFlow } from "./parsers/flows.js";
import { parseApexClass, parseApexTrigger } from "./parsers/apex.js";
import { parsePermissionContainer } from "./parsers/permissions.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".sfdx", ".sf", ".vscode", ".idea", "dist"]);

const AGENT_SUFFIXES = [
  ".genAiFunction-meta.xml",
  ".genAiPlugin-meta.xml",
  ".genAiPlannerBundle",
  ".genAiPromptTemplate-meta.xml",
  ".bot-meta.xml",
  ".botVersion-meta.xml",
  ".aiEvaluationDefinition-meta.xml",
];

function strip(name: string, suffix: string): string {
  return name.slice(0, name.length - suffix.length);
}

/**
 * Classify a metadata file by its SFDX source-format path. Works on any nesting under a
 * package directory because it only looks at the trailing path segments.
 */
export function classifyPath(relPath: string): ComponentRef {
  const file = toPosix(relPath);
  const parts = file.split("/");
  const base = parts[parts.length - 1] ?? file;
  const parent = parts[parts.length - 2];
  const grand = parts[parts.length - 3];
  const great = parts[parts.length - 4];

  if (great === "objects" && grand && parent === "fields" && base.endsWith(".field-meta.xml")) {
    const field = strip(base, ".field-meta.xml");
    return { type: "CustomField", name: `${grand}.${field}`, object: grand, file };
  }
  if (great === "objects" && grand && parent === "validationRules" && base.endsWith(".validationRule-meta.xml")) {
    const rule = strip(base, ".validationRule-meta.xml");
    return { type: "ValidationRule", name: `${grand}.${rule}`, object: grand, file };
  }
  if (grand === "objects" && parent && base === `${parent}.object-meta.xml`) {
    return { type: "CustomObject", name: parent, object: parent, file };
  }
  if (great === "objects" && grand && parent) {
    const name = base.replace(/\.[A-Za-z]+-meta\.xml$/, "");
    return { type: "ObjectChild", name: `${grand}.${parent}.${name}`, object: grand, file };
  }
  if (base.endsWith(".flow-meta.xml")) return { type: "Flow", name: strip(base, ".flow-meta.xml"), file };
  if (base.endsWith(".trigger")) return { type: "ApexTrigger", name: strip(base, ".trigger"), file };
  if (base.endsWith(".trigger-meta.xml")) return { type: "ApexTrigger", name: strip(base, ".trigger-meta.xml"), file };
  if (base.endsWith(".cls")) return { type: "ApexClass", name: strip(base, ".cls"), file };
  if (base.endsWith(".cls-meta.xml")) return { type: "ApexClass", name: strip(base, ".cls-meta.xml"), file };
  if (base.endsWith(".permissionset-meta.xml")) {
    return { type: "PermissionSet", name: strip(base, ".permissionset-meta.xml"), file };
  }
  if (base.endsWith(".profile-meta.xml")) return { type: "Profile", name: strip(base, ".profile-meta.xml"), file };
  if (base.endsWith(".workflow-meta.xml")) return { type: "WorkflowRule", name: strip(base, ".workflow-meta.xml"), file };
  const agentSuffix = AGENT_SUFFIXES.find((s) => base.endsWith(s) || parent?.endsWith(s.replace("-meta.xml", "")));
  if (agentSuffix) return { type: "AgentMetadata", name: base.replace(/\..*$/, ""), file };
  return { type: "Other", name: base, file };
}

/** Read `sfdx-project.json` package directories; fall back to `force-app` or the project root. */
export function sourceRoots(projectDir: string): string[] {
  const projectJson = path.join(projectDir, "sfdx-project.json");
  if (existsSync(projectJson)) {
    try {
      const json = JSON.parse(readFileSync(projectJson, "utf8")) as { packageDirectories?: { path: string }[] };
      const dirs = (json.packageDirectories ?? []).map((d) => d.path).filter((p) => existsSync(path.join(projectDir, p)));
      if (dirs.length) return dirs.map(toPosix);
    } catch {
      // fall through
    }
  }
  if (existsSync(path.join(projectDir, "force-app"))) return ["force-app"];
  return ["."];
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function ensureObject(model: OrgModel, name: string): ObjectDef {
  let obj = model.objects.get(key(name));
  if (!obj) {
    obj = { name, fields: new Map() };
    model.objects.set(key(name), obj);
  }
  return obj;
}

/** Load and parse every supported metadata file in an SFDX project. */
export function loadProject(projectDirInput: string): OrgModel {
  const projectDir = path.resolve(projectDirInput);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }
  const roots = sourceRoots(projectDir);
  const model: OrgModel = {
    projectDir,
    sourceRoots: roots,
    objects: new Map(),
    validationRules: [],
    flows: new Map(),
    triggers: new Map(),
    classes: new Map(),
    permissionContainers: new Map(),
    components: new Map(),
    warnings: [],
  };

  const files: string[] = [];
  for (const root of roots) walk(path.join(projectDir, root), files);

  const refs = files.map((abs) => classifyPath(toPosix(path.relative(projectDir, abs))));
  for (const ref of refs) model.components.set(ref.file, ref);

  // Objects first, so Apex analysis knows which custom objects exist.
  for (const ref of refs) {
    if (ref.object) ensureObject(model, ref.object);
    if (ref.type === "CustomObject") ensureObject(model, ref.name).file = ref.file;
  }
  const projectObjects = new Set(model.objects.keys());

  const read = (rel: string) => readFileSync(path.join(projectDir, rel), "utf8");
  const safely = (ref: ComponentRef, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      model.warnings.push(`Could not parse ${ref.file}: ${(err as Error).message}`);
    }
  };

  let legacyWorkflow = 0;
  let processBuilders = 0;
  for (const ref of refs) {
    switch (ref.type) {
      case "CustomField":
        safely(ref, () => {
          const [object, fieldName] = [ref.object!, ref.name.split(".")[1]!];
          const field = parseField(read(ref.file), object, fieldName, ref.file);
          ensureObject(model, object).fields.set(key(field.name), field);
        });
        break;
      case "ValidationRule":
        safely(ref, () => {
          model.validationRules.push(parseValidationRule(read(ref.file), ref.object!, ref.name.split(".")[1]!, ref.file));
        });
        break;
      case "Flow":
        safely(ref, () => {
          const flow = parseFlow(read(ref.file), ref.name, ref.file);
          if (flow.processType === "Workflow") processBuilders++;
          model.flows.set(key(flow.name), flow);
        });
        break;
      case "ApexTrigger":
        if (!ref.file.endsWith(".trigger")) break;
        safely(ref, () => {
          const trig = parseApexTrigger(read(ref.file), ref.name, ref.file, projectObjects);
          if (trig) model.triggers.set(key(trig.name), trig);
          else model.warnings.push(`No trigger header found in ${ref.file}`);
        });
        break;
      case "ApexClass":
        if (!ref.file.endsWith(".cls")) break;
        safely(ref, () => {
          const cls = parseApexClass(read(ref.file), ref.name, ref.file, projectObjects);
          model.classes.set(key(cls.name), cls);
        });
        break;
      case "PermissionSet":
      case "Profile":
        safely(ref, () => {
          const pc = parsePermissionContainer(read(ref.file), ref.name, ref.type as "PermissionSet" | "Profile", ref.file);
          model.permissionContainers.set(key(`${ref.type}:${pc.name}`), pc);
        });
        break;
      case "WorkflowRule":
        legacyWorkflow++;
        break;
      default:
        break;
    }
  }

  if (legacyWorkflow) {
    model.warnings.push(`${legacyWorkflow} legacy workflow file(s) found; workflow rules are not analyzed yet.`);
  }
  if (processBuilders) {
    model.warnings.push(`${processBuilders} Process Builder flow(s) found; Process Builder is not analyzed yet.`);
  }
  return model;
}
