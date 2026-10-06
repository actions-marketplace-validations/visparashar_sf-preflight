// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { allAgentActions } from "../agentImpact.js";
import { assertSafeRef, git, gitChangedFiles, gitRoot, gitShow, toChanges } from "../changes.js";
import { callersOfClass, callersOfFlow } from "../graph.js";
import { classifyPath } from "../project.js";
import type { Change, ComponentRef, OrgModel } from "../types.js";
import { key, toPosix, uniq } from "../util.js";
import {
  type ChangeRef,
  cleanSubject,
  commitTitle,
  describeComponent,
  type HistoryChange,
  type SuspectComponent,
} from "./trace.js";

/**
 * A partial rollback: undo only the components of a change that an incident points to, plus
 * whatever keeps the result consistent. Modified and deleted components go back to their version
 * before the change; components the change added are deactivated where Salesforce allows it (flows,
 * validation rules, triggers) and otherwise kept with instructions, because deleting a field loses
 * its data and deleting a class breaks its callers.
 *
 * The plan is a set of file restores, removals and edits meant to land as a pull request, so the
 * rollback gets the same review, quality gate and evidence as any change. Nothing is deployed.
 */

/** A change to one file: replace `from` with `to`, or create the file with `to` when `from` is absent. */
export interface FileEdit {
  file: string;
  from?: string;
  to: string;
}

export interface RollbackStep {
  component: SuspectComponent;
  action: "restore" | "deactivate" | "keep" | "remove";
  how: string;
  /** Project-relative files restored to their version before the change. */
  restore: string[];
  /** Files the change added to the component, removed from the project so it matches its earlier version. */
  remove: string[];
  /** Edits that deactivate a component the change added or renamed. */
  edits: FileEdit[];
  /** Set when the step was added to keep the rollback consistent. */
  because?: string;
}

export interface RollbackPlan {
  change: ChangeRef;
  /** The commit the components are restored from (the change's first parent). */
  parent: string;
  steps: RollbackStep[];
  warnings: string[];
  /** Project-relative files to deploy once restored and edited. */
  deploy: string[];
  /** The rollback includes Apex, so production deployments run tests. */
  apex: boolean;
  commands: string[];
}

/** A single commit as a change: its first parent, files and components. */
export function changeAt(projectDir: string, commit: string): HistoryChange {
  const root = gitRoot(projectDir);
  if (!root) throw new Error(`Not a git repository: ${projectDir}`);
  assertSafeRef(commit, "commit");
  let sha: string;
  try {
    sha = git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).trim();
  } catch {
    throw new Error(`Unknown commit: ${commit}`);
  }
  const [parents = "", date = "", subject = ""] = git(root, [
    "log",
    "-1",
    "--no-show-signature",
    "--format=%P%x1f%cI%x1f%s",
    sha,
  ])
    .trim()
    .split("\x1f");
  const parent = parents.split(" ")[0];
  if (!parent) throw new Error(`${commit} has no parent commit to roll back to.`);
  const files = gitChangedFiles({ projectDir, base: parent, head: sha });
  return {
    sha,
    shortSha: sha.slice(0, 7),
    date: new Date(date).toISOString(),
    ...commitTitle(root, sha, subject),
    parent,
    files,
    changes: toChanges(files).changes,
  };
}

type Identity = Pick<ComponentRef, "type" | "name"> & { object?: string };
const sameComponent = (a: Identity, b: Identity) => a.type === b.type && key(a.name) === key(b.name);
const simpleName = (name: string) => name.split(".").at(-1)!;

/** Does the text mention a name as a whole word? */
function mentions(text: string | undefined, name: string): boolean {
  const word = simpleName(name).replace(/[^A-Za-z0-9_]/g, "");
  if (!text || !word) return false;
  const lower = text.toLowerCase();
  const w = word.toLowerCase();
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) {
    if (!isWord(lower[i - 1]) && !isWord(lower[i + w.length])) return true;
  }
  return false;
}

/**
 * Does metadata or code (`text`, belonging to `owner` object when it's an object's rule or field)
 * refer to the component? Only for components other metadata can refer to by name: classes, flows,
 * objects and fields (by object and field, so `Case.Status__c` isn't `Account.Status__c`).
 */
function references(text: string | undefined, owner: string | undefined, target: Identity): boolean {
  if (!text) return false;
  switch (target.type) {
    case "ApexClass":
    case "Flow":
    case "CustomObject":
      return mentions(text, target.name);
    case "CustomField": {
      const [object, field] = target.name.split(".");
      if (!object || !field || !mentions(text, field)) return false;
      return (!!owner && key(owner) === key(object)) || mentions(text, object);
    }
    default:
      return false;
  }
}

/** The object a component belongs to, when it belongs to one. */
function ownerObject(model: OrgModel, c: Identity): string | undefined {
  if (c.object) return c.object;
  if (c.type === "ApexTrigger") return model.triggers.get(key(c.name))?.object;
  if (c.type === "Flow") return model.flows.get(key(c.name))?.trigger?.object;
  return undefined;
}

const FLOW_DEFINITION = (activeVersion: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<FlowDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n    <activeVersionNumber>${activeVersion}</activeVersionNumber>\n</FlowDefinition>\n`;

/** Where a flow's FlowDefinition lives: `…/flowDefinitions/Name.flowDefinition-meta.xml` beside `…/flows`. */
const flowDefinitionFile = (flowFile: string, name: string) =>
  path.posix.join(
    path.posix.dirname(path.posix.dirname(toPosix(flowFile))),
    "flowDefinitions",
    `${name}.flowDefinition-meta.xml`,
  );

interface Deactivation {
  edits: FileEdit[];
  how: string;
  /** Set when the edit couldn't be prepared. */
  problem?: string;
}

/**
 * Deactivate a component through a deployment: `active` false for validation rules, an Inactive
 * status for triggers, and for flows a FlowDefinition with no active version (a flow's own status
 * doesn't deactivate it when deployed).
 */
function deactivation(
  comp: Identity & { file: string },
  read: (file: string) => string | undefined,
): Deactivation | undefined {
  const replace = (file: string, re: RegExp, to: string, how: string): Deactivation => {
    const text = read(file);
    const from = text ? re.exec(text)?.[0] : undefined;
    return from
      ? { edits: [{ file, from, to }], how }
      : { edits: [], how, problem: `Couldn't find ${re.source.replace(/\\/g, "")} in ${file}` };
  };
  switch (comp.type) {
    case "ValidationRule":
      return replace(comp.file, /<active>true<\/active>/, "<active>false</active>", "Set `active` to false.");
    case "ApexTrigger": {
      const file = comp.file.endsWith("-meta.xml") ? comp.file : `${comp.file}-meta.xml`;
      return replace(file, /<status>Active<\/status>/, "<status>Inactive</status>", "Set its status to `Inactive`.");
    }
    case "Flow": {
      const file = flowDefinitionFile(comp.file, comp.name);
      const how =
        "Deploy a FlowDefinition with no active version (deploying the flow itself can't deactivate it), or deactivate it in Setup → Flows.";
      const existing = read(file);
      if (existing === undefined) return { edits: [{ file, to: FLOW_DEFINITION(0) }], how };
      const from = /<activeVersionNumber>\s*\d+\s*<\/activeVersionNumber>/.exec(existing)?.[0];
      if (!from)
        return {
          edits: [
            {
              file,
              from: "</FlowDefinition>",
              to: "    <activeVersionNumber>0</activeVersionNumber>\n</FlowDefinition>",
            },
          ],
          how,
        };
      return { edits: [{ file, from, to: "<activeVersionNumber>0</activeVersionNumber>" }], how };
    }
    default:
      return undefined;
  }
}

export interface PlanRollbackOptions {
  projectDir: string;
  model: OrgModel;
  change: HistoryChange;
  /** Components to roll back, by name ("Opportunity.Rule", "MyClass") or "Type:name"; default all. */
  components?: string[];
  /** Org alias for the deploy commands (a placeholder otherwise). */
  org?: string;
}

export function planRollback(opts: PlanRollbackOptions): RollbackPlan {
  const { projectDir, model, change } = opts;
  const root = gitRoot(projectDir)!;
  const repoRel = (f: string) => toPosix(path.relative(root, path.join(projectDir, f)));
  const projectRel = (f: string) => toPosix(path.relative(projectDir, path.join(root, f)));
  const read = (file: string) => {
    try {
      return readFileSync(path.join(projectDir, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const before = (c: Change) => gitShow(projectDir, change.parent, c.previousFile ?? c.component.file);

  // A component's files at a commit, from the commit's tree: a class and its -meta.xml, a
  // trigger and its -meta.xml, a bot and its versions.
  const listed = new Map<string, string[]>();
  const filesAt = (ref: string, id: Identity, hint: string): string[] => {
    const dir = path.posix.dirname(repoRel(hint));
    const k = `${ref}:${dir}`;
    let all = listed.get(k);
    if (!all) {
      try {
        all = git(root, ["ls-tree", "-r", "--name-only", ref, "--", `${dir}/`])
          .split("\n")
          .filter(Boolean)
          .map(projectRel);
      } catch {
        all = [];
      }
      listed.set(k, all);
    }
    return all.filter((f) => sameComponent(classifyPath(f), id));
  };

  let selected: Change[];
  if (opts.components?.length) {
    selected = [];
    for (const wanted of opts.components) {
      const [maybeType, maybeName] = wanted.includes(":") ? wanted.split(":", 2) : [undefined, wanted];
      const hit = change.changes.filter(
        (c) => key(c.component.name) === key(maybeName!) && (!maybeType || key(c.component.type) === key(maybeType)),
      );
      if (!hit.length) {
        throw new Error(
          `${change.shortSha} didn't change ${wanted}. It changed: ${change.changes.map((c) => c.component.name).join(", ")}.`,
        );
      }
      selected.push(...hit.filter((h) => !selected.includes(h)));
    }
  } else selected = [...change.changes];

  const steps: RollbackStep[] = [];
  const warnings: string[] = [];
  const noDeploy = new Set<string>();
  const queued = new Set<Change>();
  const queue: { c: Change; because?: string }[] = selected.map((c) => ({ c }));
  for (const q of queue) queued.add(q.c);
  const enqueue = (c: Change, because: string) => {
    if (queued.has(c)) return;
    queued.add(c);
    queue.push({ c, because });
  };
  const step = (s: Omit<RollbackStep, "restore" | "remove" | "edits"> & Partial<RollbackStep>): void => {
    steps.push({ restore: [], remove: [], edits: [], ...s });
  };
  const asSuspect = (c: Change, id: Identity = c.component, file = c.component.file): SuspectComponent => ({
    type: id.type,
    name: id.name,
    file,
    changeType: c.changeType,
  });

  while (queue.length) {
    const { c, because } = queue.shift()!;
    const label = describeComponent(c.component.type, c.component.name);
    const why = because ? { because } : {};

    if (c.changeType !== "added") {
      const oldFile = c.previousFile ?? c.component.file;
      const oldId: Identity = c.changeType === "renamed" ? { ...classifyPath(oldFile) } : { ...c.component };
      const oldLabel = describeComponent(oldId.type, oldId.name);
      const restore = filesAt(change.parent, oldId, oldFile);
      const atChange = filesAt(change.sha, c.component, c.component.file);
      // Files the change added to the component (e.g. a new bot version) go, so it matches its
      // earlier version; a renamed component's new files are handled below.
      const remove =
        c.changeType === "renamed" ? [] : atChange.filter((f) => !restore.includes(f) && read(f) !== undefined);
      if (!restore.length)
        warnings.push(`Couldn't find the files of ${oldLabel} before the change: restore it by hand.`);

      let how =
        c.changeType === "deleted"
          ? "The change deleted it; bring it back."
          : c.changeType === "renamed"
            ? `Bring back its previous name, \`${oldId.name}\`.`
            : "Back to its version before the change.";
      if (c.component.type === "Flow" || oldId.type === "Flow") {
        how +=
          " Deploying adds it as a new flow version, which production keeps inactive unless the org deploys flows as active: activate it in Setup → Flows (or activate its previous version there instead of deploying).";
      }
      if (c.changeType === "deleted" && c.component.type === "CustomField") {
        how =
          "The change deleted it. A deleted field and its data stay under Deleted Fields for 15 days: undelete it there (Setup → Object Manager → the object → Fields & Relationships → Deleted Fields). Its file is restored so the project matches; deploying the file instead would create an empty field.";
        for (const f of restore) noDeploy.add(f);
        warnings.push(`Undelete ${label} in Setup before deploying the rollback; the deployment leaves it out.`);
      }
      if (remove.length) {
        how += ` Remove what the change added to it (${remove.map((f) => `\`${path.posix.basename(f)}\``).join(", ")}).`;
        warnings.push(
          `Removing ${remove.map((f) => `\`${f}\``).join(", ")} from the project doesn't remove ${remove.length === 1 ? "it" : "them"} from the org: delete ${remove.length === 1 ? "it" : "them"} there too if needed.`,
        );
      }
      step({ component: asSuspect(c, oldId, oldFile), action: "restore", how, restore, remove, ...why });

      if (c.changeType === "renamed") {
        // Both names would be live: deactivate the new one where possible.
        const off = deactivation({ ...c.component, file: c.component.file }, read);
        if (off) {
          if (off.problem) warnings.push(`${off.problem}: deactivate ${label} by hand.`);
          step({
            component: asSuspect(c),
            action: "deactivate",
            how: `${off.how} Otherwise it runs alongside ${oldLabel}.`,
            edits: off.edits,
            because: `the rollback brings back ${oldLabel}, which it was renamed from`,
          });
        } else {
          step({
            component: asSuspect(c),
            action: "keep",
            how: `It stays in the org beside ${oldLabel}; delete it once nothing uses it.`,
            because: `the rollback brings back ${oldLabel}, which it was renamed from`,
          });
        }
      }

      // The previous version may rely on other components the change deleted, renamed or changed.
      const old = before(c);
      const owner = ownerObject(model, oldId);
      for (const other of change.changes) {
        if (other === c) continue;
        const otherOld: Identity =
          other.changeType === "renamed" ? { ...classifyPath(other.previousFile ?? "") } : { ...other.component };
        if (!references(old, owner, otherOld)) continue;
        const otherLabel = describeComponent(otherOld.type, otherOld.name);
        if (other.changeType === "deleted" || other.changeType === "renamed") {
          enqueue(
            other,
            `the previous version of ${oldLabel} uses ${otherLabel}, which the change ${other.changeType}`,
          );
        } else if (other.changeType === "modified" && !queued.has(other)) {
          warnings.push(
            `The previous version of ${oldLabel} uses ${otherLabel}, which the change also changed and the rollback keeps: check they still work together, or add it with \`--component ${other.component.name}\`.`,
          );
        }
      }
      // Components the rollback leaves as they are may rely on the new version.
      for (const other of change.changes) {
        if (other === c || queued.has(other) || other.changeType === "deleted") continue;
        if (references(read(other.component.file), ownerObject(model, other.component), c.component)) {
          warnings.push(
            `${describeComponent(other.component.type, other.component.name)} stays as the change left it and uses ${label}: check it works with ${oldLabel}'s previous version, or add it with \`--component ${other.component.name}\`.`,
          );
        }
      }
      continue;
    }

    const off = deactivation({ ...c.component, file: c.component.file }, read);
    if (off) {
      if (off.problem) warnings.push(`${off.problem}: deactivate ${label} by hand.`);
      step({ component: asSuspect(c), action: "deactivate", how: off.how, edits: off.edits, ...why });
      if (c.component.type === "Flow") flowCallers(c, label);
      continue;
    }
    if (c.component.type === "ApexClass") {
      const callers = callersOfClass(model, c.component.name).map((x) => x.name);
      const agentCallers = allAgentActions(model)
        .filter(
          (r) => r.action.targetType.toLowerCase() === "apex" && key(r.action.target ?? "") === key(c.component.name),
        )
        .map((r) => r.action.name);
      const users = [...callers, ...agentCallers];
      if (users.length) {
        step({
          component: asSuspect(c),
          action: "keep",
          how: `${users.map((u) => `\`${u}\``).join(", ")} use${users.length === 1 ? "s" : ""} it; roll back what calls it instead.`,
          ...why,
        });
        for (const other of change.changes) {
          if (other !== c && users.some((u) => key(u) === key(other.component.name))) {
            enqueue(other, `it calls ${label}, which the change added`);
          }
        }
      } else {
        step({
          component: asSuspect(c),
          action: "keep",
          how: `Nothing in the project calls it, so it can stay. Remove it later with a destructive deployment if it's unused (\`sf project delete source --metadata ApexClass:${c.component.name}\`).`,
          ...why,
        });
      }
      continue;
    }
    const keep: Record<string, string> = {
      CustomField: "Deleting a field deletes its data; roll back what uses it instead.",
      CustomObject: "Deleting an object deletes its records; roll back what uses it instead.",
      PermissionSet: "Unassign it, or delete it once nobody holds it.",
      AgentMetadata: "Take it out of the agent, or deactivate the agent version that uses it.",
    };
    step({
      component: asSuspect(c),
      action: c.component.type === "CustomField" || c.component.type === "CustomObject" ? "keep" : "remove",
      how: keep[c.component.type] ?? "Delete it, or deploy a change that undoes it.",
      ...why,
    });
  }

  /** What runs a flow the rollback deactivates: changed callers go back too, others get a warning. */
  function flowCallers(c: Change, label: string): void {
    const name = c.component.name;
    const apexCalls = (text: string | undefined) =>
      !!text &&
      (new RegExp(`\\bFlow\\.Interview\\.${name}\\b`, "i").test(text) ||
        new RegExp(`createInterview\\(\\s*'${name}'`, "i").test(text));
    // Callers in the project as it is now, each with the component that defines it.
    const callers: { label: string; id: Identity }[] = [];
    for (const f of callersOfFlow(model, name)) {
      callers.push({ label: describeComponent("Flow", f.name), id: { type: "Flow", name: f.name } });
    }
    for (const cls of model.classes.values()) {
      if (apexCalls(read(cls.file))) {
        callers.push({ label: describeComponent("ApexClass", cls.name), id: { type: "ApexClass", name: cls.name } });
      }
    }
    for (const r of allAgentActions(model)) {
      if (r.action.targetType.toLowerCase() === "flow" && key(r.action.target ?? "") === key(name)) {
        callers.push({ label: describeComponent("AgentAction", r.action.name), id: classifyPath(r.action.file) });
      }
    }
    const outside: string[] = [];
    for (const caller of callers) {
      const inChange = change.changes.find((o) => o !== c && sameComponent(o.component, caller.id));
      if (inChange) enqueue(inChange, `it runs ${label}, which the rollback deactivates`);
      else outside.push(caller.label);
    }
    if (outside.length) {
      const one = outside.length === 1;
      warnings.push(
        `${uniq(outside).join(", ")} run${one ? "s" : ""} ${label} and ${one ? "isn't" : "aren't"} part of this change: deactivating it makes ${one ? "that" : "them"} fail. Roll ${one ? "it" : "them"} back too, or keep the flow.`,
      );
    }
  }

  // Restoring the version before the change also undoes later commits to the same files.
  const restored = [...new Set(steps.flatMap((s) => s.restore))];
  const removed = [...new Set(steps.flatMap((s) => s.remove))];
  const touched = [...restored, ...removed];
  if (touched.length) {
    try {
      const later = git(root, ["log", "--format=%h%x1f%s", `${change.sha}..HEAD`, "--", ...touched.map(repoRel)])
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, subject = ""] = l.split("\x1f");
          return `\`${sha}\` ${cleanSubject(subject).slice(0, 80)}`;
        });
      if (later.length) {
        warnings.push(
          `Later commits also changed the files being restored, and restoring the versions before \`${change.shortSha}\` undoes them too: ${later.slice(0, 5).join("; ")}${later.length > 5 ? ` and ${later.length - 5} more` : ""}.`,
        );
      }
    } catch {
      // History unavailable (e.g. the change isn't an ancestor of HEAD).
    }
  }

  const deploy = [
    ...new Set([...restored.filter((f) => !noDeploy.has(f)), ...steps.flatMap((s) => s.edits.map((e) => e.file))]),
  ];
  const apex = steps.some(
    (s) =>
      (s.component.type === "ApexClass" || s.component.type === "ApexTrigger") && (s.restore.length || s.edits.length),
  );
  const org = opts.org ?? "<org>";
  const componentArgs = opts.components?.length ? ` --component ${opts.components.join(" ")}` : "";
  const commands =
    deploy.length || removed.length
      ? [
          `git checkout -b rollback/${change.shortSha}`,
          `preflight rollback ${change.shortSha}${componentArgs} --restore`,
          "preflight analyze --base HEAD --gate",
          ...(deploy.length
            ? [
                `sf project deploy validate --target-org ${org}${apex ? " --test-level RunLocalTests" : ""} ${deploy.map((f) => `--source-dir ${f}`).join(" ")}`,
                `sf project deploy quick --job-id <id from validate> --target-org ${org}`,
              ]
            : []),
        ]
      : [];
  return { change: strip(change), parent: change.parent, steps, warnings, deploy, apex, commands };
}

const strip = (h: HistoryChange): ChangeRef => {
  const { parent: _p, files: _f, changes: _c, ...ref } = h;
  return ref;
};

export interface AppliedRollback {
  restored: string[];
  removed: string[];
  edited: string[];
  created: string[];
  /** Edits that no longer applied (the file changed since the plan). */
  skipped: string[];
}

/** Replace text in a file through one open handle, so nothing can change it between read and write. */
function replaceInFile(abs: string, from: string, to: string): boolean {
  let fd: number;
  try {
    fd = openSync(abs, "r+");
  } catch {
    return false;
  }
  try {
    const text = readFileSync(fd, "utf8");
    if (!text.includes(from)) return false;
    const out = Buffer.from(
      text.replace(from, () => to),
      "utf8",
    );
    ftruncateSync(fd, 0);
    writeSync(fd, out, 0, out.length, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Create a file that must not exist yet. */
function createFile(abs: string, content: string): boolean {
  mkdirSync(path.dirname(abs), { recursive: true });
  let fd: number;
  try {
    fd = openSync(abs, "wx");
  } catch {
    return false;
  }
  try {
    writeSync(fd, content);
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Apply a plan to the working tree: restore files from before the change, remove what the change
 * added to restored components, and make the deactivation edits. Nothing is staged, committed or
 * deployed; files with uncommitted changes are refused.
 */
export function applyRollback(projectDir: string, plan: RollbackPlan): AppliedRollback {
  const root = gitRoot(projectDir);
  if (!root) throw new Error(`Not a git repository: ${projectDir}`);
  const parent = assertSafeRef(plan.parent, "commit");
  const restore = [...new Set(plan.steps.flatMap((s) => s.restore))];
  const remove = [...new Set(plan.steps.flatMap((s) => s.remove))].filter((f) => !restore.includes(f));
  const edits = plan.steps.flatMap((s) => s.edits);
  const touched = [...new Set([...restore, ...remove, ...edits.map((e) => e.file)])];
  const applied: AppliedRollback = { restored: [], removed: [], edited: [], created: [], skipped: [] };
  if (!touched.length) return applied;
  const inProject = (f: string) => {
    const abs = path.resolve(projectDir, f);
    const rel = path.relative(path.resolve(projectDir), abs);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new Error(`Refusing to touch a file outside the project: ${f}`);
    return abs;
  };
  const repoRel = (f: string) => toPosix(path.relative(root, inProject(f)));
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...touched.map(repoRel)]).trim();
  if (dirty) {
    throw new Error(`These files have uncommitted changes; commit or stash them first:\n${dirty}`);
  }
  if (restore.length) {
    // The working tree only: nothing is staged, so `git status` and `git diff` show the rollback.
    execFileSync("git", ["restore", `--source=${parent}`, "--worktree", "--", ...restore.map(repoRel)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    applied.restored = restore;
  }
  for (const f of remove) {
    rmSync(inProject(f), { force: true });
    applied.removed.push(f);
  }
  for (const e of edits) {
    const abs = inProject(e.file);
    if (e.from === undefined) {
      if (createFile(abs, e.to)) applied.created.push(e.file);
      else applied.skipped.push(e.file);
    } else if (replaceInFile(abs, e.from, e.to)) applied.edited.push(e.file);
    else applied.skipped.push(e.file);
  }
  return applied;
}
