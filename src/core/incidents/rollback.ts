// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allAgentActions } from "../agentImpact.js";
import { assertSafeRef, git, gitChangedFiles, gitRoot, gitShow, toChanges } from "../changes.js";
import { callersOfClass } from "../graph.js";
import { classifyPath } from "../project.js";
import type { Change, OrgModel } from "../types.js";
import { key, redactEmails, toPosix } from "../util.js";
import { type ChangeRef, commitTitle, describeComponent, type HistoryChange, type SuspectComponent } from "./trace.js";

/**
 * A partial rollback: undo only the components of a change that an incident points to, plus
 * whatever keeps the result consistent. Modified and deleted components go back to their version
 * before the change; components the change added are deactivated where Salesforce allows it (flows,
 * validation rules, triggers) and otherwise kept with instructions, because deleting a field loses
 * its data and deleting a class breaks its callers.
 *
 * The plan is a set of file restores and edits meant to land as a pull request, so the rollback
 * gets the same review, quality gate and evidence as any change. Nothing is deployed.
 */

export interface RollbackStep {
  component: SuspectComponent;
  action: "restore" | "deactivate" | "keep" | "remove";
  how: string;
  /** Project-relative files restored to their version before the change. */
  restore: string[];
  /** Edits that deactivate a component the change added (applied to the current file). */
  edits: { file: string; from: string; to: string }[];
  /** Set when the step was added to keep the rollback consistent. */
  because?: string;
}

export interface RollbackPlan {
  change: ChangeRef;
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

const sameComponent = (a: Change["component"], b: Change["component"]) =>
  a.type === b.type && key(a.name) === key(b.name);
const simpleName = (name: string) => name.split(".").at(-1)!;
/** Does the text mention a component's API name as a whole word? */
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

const DEACTIVATE: Partial<Record<string, { file: (c: Change) => string; from: string; to: string; how: string }>> = {
  ValidationRule: {
    file: (c) => c.component.file,
    from: "<active>true</active>",
    to: "<active>false</active>",
    how: "Set `active` to false.",
  },
  Flow: {
    file: (c) => c.component.file,
    from: "<status>Active</status>",
    to: "<status>Obsolete</status>",
    how: "Set its status to `Obsolete` (or deactivate it in Setup → Flows).",
  },
  ApexTrigger: {
    file: (c) => (c.component.file.endsWith("-meta.xml") ? c.component.file : `${c.component.file}-meta.xml`),
    from: "<status>Active</status>",
    to: "<status>Inactive</status>",
    how: "Set its status to `Inactive`.",
  },
};

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
  const read = (file: string) => {
    const abs = path.join(projectDir, file);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  };
  const before = (c: Change) => gitShow(projectDir, change.parent, c.previousFile ?? c.component.file);
  const filesOf = (c: Change) => {
    const own = change.files.filter((f) => {
      const comp = classifyPath(f.file);
      return comp.type !== "Other" && sameComponent(comp, c.component);
    });
    return own.length ? own : [{ file: c.component.file, changeType: c.changeType, previousFile: c.previousFile }];
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
  const queued = new Set<Change>();
  const queue: { c: Change; because?: string }[] = selected.map((c) => ({ c }));
  for (const q of queue) queued.add(q.c);
  const enqueue = (c: Change, because: string) => {
    if (queued.has(c)) return;
    queued.add(c);
    queue.push({ c, because });
  };

  while (queue.length) {
    const { c, because } = queue.shift()!;
    const component = {
      type: c.component.type,
      name: c.component.name,
      file: c.component.file,
      changeType: c.changeType,
    };
    const label = describeComponent(c.component.type, c.component.name);
    if (c.changeType !== "added") {
      const files = filesOf(c);
      const restore = files.map((f) => f.previousFile ?? f.file);
      steps.push({
        component,
        action: "restore",
        how:
          c.changeType === "deleted"
            ? "The change deleted it; bring it back."
            : c.changeType === "renamed"
              ? `Bring back its previous name (\`${c.previousFile}\`) and remove the renamed file.`
              : "Back to its version before the change.",
        restore,
        edits: [],
        ...(because ? { because } : {}),
      });
      // The previous version may use something the change deleted or renamed.
      const old = before(c);
      for (const other of change.changes) {
        if (other === c || (other.changeType !== "deleted" && other.changeType !== "renamed")) continue;
        const oldName =
          other.changeType === "renamed" ? classifyPath(other.previousFile ?? "").name : other.component.name;
        if (oldName && mentions(old, oldName)) {
          enqueue(
            other,
            `the previous version of ${label} uses ${describeComponent(other.component.type, oldName)}, which the change ${other.changeType}`,
          );
        }
      }
      // Components the rollback leaves as they are may rely on the new version.
      for (const other of change.changes) {
        if (other === c || queued.has(other) || other.changeType === "deleted") continue;
        if (mentions(read(other.component.file), c.component.name)) {
          warnings.push(
            `${describeComponent(other.component.type, other.component.name)} stays as the change left it and uses ${label}: check it works with ${label}'s previous version, or add it with \`--component ${other.component.name}\`.`,
          );
        }
      }
      continue;
    }

    const off = DEACTIVATE[c.component.type];
    if (off) {
      const file = off.file(c);
      const current = read(file);
      const edits = current?.includes(off.from) ? [{ file, from: off.from, to: off.to }] : [];
      if (!edits.length) warnings.push(`Couldn't find \`${off.from}\` in ${file}: deactivate ${label} by hand.`);
      steps.push({
        component,
        action: "deactivate",
        how: off.how,
        restore: [],
        edits,
        ...(because ? { because } : {}),
      });
      if (c.component.type === "Flow") {
        // Changed flows that call the new flow as a subflow must go back too.
        for (const other of change.changes) {
          if (
            other !== c &&
            other.component.type === "Flow" &&
            mentions(read(other.component.file), c.component.name)
          ) {
            enqueue(other, `it runs ${label}, which the rollback deactivates`);
          }
        }
      }
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
        steps.push({
          component,
          action: "keep",
          how: `${users.map((u) => `\`${u}\``).join(", ")} use${users.length === 1 ? "s" : ""} it; roll back what calls it instead.`,
          restore: [],
          edits: [],
          ...(because ? { because } : {}),
        });
        for (const other of change.changes) {
          if (other !== c && users.some((u) => key(u) === key(other.component.name))) {
            enqueue(other, `it calls ${label}, which the change added`);
          }
        }
      } else {
        steps.push({
          component,
          action: "keep",
          how: `Nothing in the project calls it, so it can stay. Remove it later with a destructive deployment if it's unused (\`sf project delete source --metadata ApexClass:${c.component.name}\`).`,
          restore: [],
          edits: [],
          ...(because ? { because } : {}),
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
    steps.push({
      component,
      action: c.component.type === "CustomField" || c.component.type === "CustomObject" ? "keep" : "remove",
      how: keep[c.component.type] ?? "Delete it, or deploy a change that undoes it.",
      restore: [],
      edits: [],
      ...(because ? { because } : {}),
    });
  }

  // Restoring the version before the change also undoes later commits to the same files.
  const restored = steps.flatMap((s) => s.restore);
  if (restored.length) {
    try {
      const repoRel = restored.map((f) => toPosix(path.relative(root, path.join(projectDir, f))));
      const later = git(root, ["log", "--format=%h%x1f%s", `${change.sha}..HEAD`, "--", ...repoRel])
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, subject = ""] = l.split("\x1f");
          return `\`${sha}\` ${redactEmails(subject).slice(0, 80)}`;
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

  const deploy = [...new Set([...restored, ...steps.flatMap((s) => s.edits.map((e) => e.file))])];
  const apex = steps.some(
    (s) =>
      (s.component.type === "ApexClass" || s.component.type === "ApexTrigger") && (s.restore.length || s.edits.length),
  );
  const org = opts.org ?? "<org>";
  const componentArgs =
    opts.components?.length || steps.length !== change.changes.length
      ? ` --component ${steps
          .filter((s) => !s.because)
          .map((s) => s.component.name)
          .join(" ")}`
      : "";
  const commands = deploy.length
    ? [
        `git checkout -b rollback/${change.shortSha}`,
        `preflight rollback ${change.shortSha}${componentArgs} --restore`,
        "preflight analyze --base HEAD --gate",
        `sf project deploy validate --target-org ${org}${apex ? " --test-level RunLocalTests" : ""} ${deploy.map((f) => `--source-dir ${f}`).join(" ")}`,
        `sf project deploy quick --job-id <id from validate> --target-org ${org}`,
      ]
    : [];
  return { change: strip(change), steps, warnings, deploy, apex, commands };
}

const strip = (h: HistoryChange): ChangeRef => {
  const { parent: _p, files: _f, changes: _c, ...ref } = h;
  return ref;
};

/**
 * Apply a plan to the working tree: restore files from before the change and make the
 * deactivation edits. Refuses to touch files with uncommitted changes. Nothing is deployed.
 */
export function applyRollback(
  projectDir: string,
  plan: RollbackPlan,
  sha: string,
): { restored: string[]; edited: string[] } {
  const root = gitRoot(projectDir);
  if (!root) throw new Error(`Not a git repository: ${projectDir}`);
  assertSafeRef(sha, "commit");
  const restore = [...new Set(plan.steps.flatMap((s) => s.restore))];
  const edits = plan.steps.flatMap((s) => s.edits);
  const touched = [...new Set([...restore, ...edits.map((e) => e.file)])];
  if (!touched.length) return { restored: [], edited: [] };
  const repoRel = (f: string) => toPosix(path.relative(root, path.join(projectDir, f)));
  const dirty = git(root, ["status", "--porcelain", "--", ...touched.map(repoRel)]).trim();
  if (dirty) {
    throw new Error(`These files have uncommitted changes; commit or stash them first:\n${dirty}`);
  }
  if (restore.length) {
    execFileSync("git", ["checkout", `${sha}^`, "--", ...restore.map(repoRel)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const edited: string[] = [];
  for (const e of edits) {
    const abs = path.join(projectDir, e.file);
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    if (!text.includes(e.from)) continue;
    writeFileSync(abs, text.replace(e.from, e.to));
    edited.push(e.file);
  }
  return { restored: restore, edited };
}
