// SPDX-License-Identifier: Apache-2.0
import { classWrites, flowWrites } from "./graph.js";
import { saveProcedure } from "./orderOfExecution.js";
import { agentActions } from "./parsers/agents.js";
import type {
  AccessNeed,
  AgentAction,
  AgentDef,
  AgentImpact,
  AgentTopic,
  AutomationRef,
  Change,
  ComponentRef,
  DmlOp,
  Finding,
  OrgModel,
  SaveEvent,
  SaveProcedure,
  SuggestedTest,
  Write,
} from "./types.js";
import { key, uniq, uniqBy } from "./util.js";

/**
 * Agent action verification: which agent actions a change reaches, through what they call and
 * the save procedures that follow, and what their runtime user needs.
 */

export interface AgentActionRef {
  agent: AgentDef;
  topic?: AgentTopic;
  action: AgentAction;
}

export function allAgentActions(model: OrgModel): AgentActionRef[] {
  return [...model.agents.values()].flatMap((agent) => agentActions(agent).map((r) => ({ agent, ...r })));
}

export interface ActionTarget {
  kind: "ApexClass" | "Flow" | "PromptTemplate" | "Other";
  name?: string;
  file?: string;
  /** The class or flow is defined in the project (so preflight can follow it). */
  inProject: boolean;
}

const PROMPT_TYPES = new Set(["prompt", "generatepromptresponse"]);

export function actionTarget(model: OrgModel, action: AgentAction): ActionTarget {
  const type = action.targetType.toLowerCase();
  if (type === "apex") {
    const cls = action.target ? model.classes.get(key(action.target)) : undefined;
    return { kind: "ApexClass", name: cls?.name ?? action.target, file: cls?.file, inProject: !!cls };
  }
  if (type === "flow") {
    const flow = action.target ? model.flows.get(key(action.target)) : undefined;
    return { kind: "Flow", name: flow?.name ?? action.target, file: flow?.file, inProject: !!flow };
  }
  if (PROMPT_TYPES.has(type)) {
    const target = action.target ? key(action.target) : undefined;
    const file = [...model.components.values()].find(
      (c) => c.agentKind === "promptTemplate" && key(c.name) === target,
    )?.file;
    return { kind: "PromptTemplate", name: action.target, file, inProject: !!file };
  }
  return { kind: "Other", name: action.target, inProject: false };
}

export function targetRef(t: ActionTarget): AutomationRef | undefined {
  if (!t.inProject || !t.name) return undefined;
  if (t.kind === "ApexClass") return { kind: "ApexClass", name: t.name, file: t.file };
  if (t.kind === "Flow") return { kind: "Flow", name: t.name, file: t.file };
  return undefined;
}

/** Records the action writes through its Apex class or flow (and what those call). */
export function actionWrites(model: OrgModel, action: AgentAction): Write[] {
  const t = actionTarget(model, action);
  if (!t.inProject || !t.name) return [];
  if (t.kind === "ApexClass") return classWrites(model, model.classes.get(key(t.name))!);
  if (t.kind === "Flow") return flowWrites(model, model.flows.get(key(t.name))!);
  return [];
}

/** Classes and flows an action runs, directly or through what they call. */
export function actionCode(model: OrgModel, action: AgentAction): { classes: Set<string>; flows: Set<string> } {
  const classes = new Set<string>();
  const flows = new Set<string>();
  const visitClass = (name: string) => {
    const cls = model.classes.get(key(name));
    if (!cls || classes.has(key(cls.name))) return;
    classes.add(key(cls.name));
    for (const ref of cls.classRefs) visitClass(ref);
  };
  const visitFlow = (name: string) => {
    const flow = model.flows.get(key(name));
    if (!flow || flows.has(key(flow.name))) return;
    flows.add(key(flow.name));
    for (const a of flow.apexActions) visitClass(a);
    for (const s of flow.subflows) visitFlow(s);
  };
  const t = actionTarget(model, action);
  if (t.kind === "ApexClass" && t.name) visitClass(t.name);
  if (t.kind === "Flow" && t.name) visitFlow(t.name);
  return { classes, flows };
}

const ACCESS: Record<DmlOp, AccessNeed["access"][number] | undefined> = {
  insert: "create",
  update: "edit",
  upsert: "edit",
  delete: "delete",
  undelete: "create",
};

/** Object access a user needs for these writes (read is implied by every entry). */
export function accessNeeds(writes: Write[]): AccessNeed[] {
  const byObject = new Map<string, AccessNeed>();
  for (const w of writes) {
    const access = ACCESS[w.op];
    const need = byObject.get(key(w.object)) ?? { object: w.object, access: [] };
    if (access && !need.access.includes(access)) need.access.push(access);
    if (w.op === "upsert" && !need.access.includes("create")) need.access.push("create");
    byObject.set(key(w.object), need);
  }
  const order = ["create", "edit", "delete"];
  return [...byObject.values()]
    .map((n) => ({ ...n, access: n.access.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }))
    .sort((a, b) => a.object.localeCompare(b.object));
}

const USER_MODE = /\bWITH\s+USER_MODE\b|\bAccessLevel\.USER_MODE\b|\bstripInaccessible\b|\bWITH\s+SECURITY_ENFORCED\b/i;

/**
 * Object access the action's user needs. Flows an agent calls run as the user; Apex runs in
 * system mode unless the class enforces user mode, so its saves need no object permissions.
 */
export function userAccess(
  model: OrgModel,
  action: AgentAction,
): { needs: AccessNeed[]; apexClass?: string; systemMode?: boolean } {
  const t = actionTarget(model, action);
  const writes = actionWrites(model, action);
  if (t.kind === "ApexClass" && t.name) {
    const cls = model.classes.get(key(t.name));
    const enforces = !!cls && USER_MODE.test(cls.stripped);
    return { needs: enforces ? accessNeeds(writes) : [], apexClass: t.name, systemMode: !enforces || undefined };
  }
  return { needs: accessNeeds(writes) };
}

/** How the agent runs: as its own user (service agents) or as the person using it. */
export function runsAs(agent: AgentDef): AgentImpact["runsAs"] {
  return agent.runtimeUser ? "dedicated user" : "signed-in user";
}

export const agentLabel = (a: AgentDef) => a.label ?? a.name;
export const actionLabel = (a: AgentAction) => a.label ?? a.name;

/** Testing Center tests of an agent, and those that expect a given action. */
export function testsFor(model: OrgModel, agent: AgentDef, action?: AgentAction) {
  const ofAgent = model.agentTests.filter((t) => key(t.subject) === key(agent.name));
  const expecting = action ? ofAgent.filter((t) => t.actions.some((a) => key(a) === key(action.name))) : [];
  return { ofAgent: ofAgent.map((t) => t.name), expecting: expecting.map((t) => t.name) };
}

const describeRef = (a: AutomationRef) =>
  a.kind === "Flow"
    ? `flow ${a.name}`
    : a.kind === "ApexTrigger"
      ? `trigger ${a.name}`
      : a.kind === "ApexClass"
        ? `class ${a.name}`
        : a.kind === "ValidationRule"
          ? `validation rule ${a.name}`
          : a.kind === "RollUpSummary"
            ? `roll-up ${a.name}`
            : a.name;

export const describeTarget = (t: ActionTarget) =>
  t.kind === "ApexClass"
    ? `class ${t.name ?? "?"}`
    : t.kind === "Flow"
      ? `flow ${t.name ?? "?"}`
      : t.kind === "PromptTemplate"
        ? `prompt template ${t.name ?? "?"}`
        : t.name
          ? t.name
          : "a standard action";

export interface AgentAnalysisInput {
  model: OrgModel;
  changes: Change[];
  maxDepth: number;
  proc: (object: string, event: SaveEvent) => SaveProcedure;
}

/** What the change touched, for matching against what agent actions reach. */
interface Touched {
  /** Lower-cased object → descriptions of what changed on it. */
  objects: Map<string, string[]>;
  /** "kind|name" lower → description, for automation in save procedures and code. */
  automation: Map<string, string>;
  /** Agent metadata changes: "agent|<name>", "topic|<name>", "action|<name>", "planner|<name>". */
  agentParts: Map<string, string>;
  deleted: Set<string>;
}

function touched(changes: Change[]): Touched {
  const t: Touched = { objects: new Map(), automation: new Map(), agentParts: new Map(), deleted: new Set() };
  const onObject = (object: string, what: string) => {
    const k = key(object);
    t.objects.set(k, uniq([...(t.objects.get(k) ?? []), what]));
  };
  for (const c of changes) {
    const comp = c.component;
    const verb = c.changeType === "added" ? "new" : c.changeType === "deleted" ? "deleted" : "changed";
    switch (comp.type) {
      case "CustomField":
        onObject(comp.object!, `${verb} field ${comp.name}`);
        break;
      case "ValidationRule":
        onObject(comp.object!, `${verb} validation rule ${comp.name.split(".")[1] ?? comp.name}`);
        break;
      case "CustomObject":
        onObject(comp.name, `${verb} object definition`);
        break;
      case "ObjectChild":
        if (comp.object) onObject(comp.object, `${verb} ${comp.name}`);
        break;
      case "Flow":
        t.automation.set(`flow|${key(comp.name)}`, `${verb} flow ${comp.name}`);
        if (c.changeType === "deleted") t.deleted.add(`flow|${key(comp.name)}`);
        break;
      case "ApexTrigger":
        t.automation.set(`apextrigger|${key(comp.name)}`, `${verb} trigger ${comp.name}`);
        break;
      case "ApexClass":
        t.automation.set(`apexclass|${key(comp.name)}`, `${verb} class ${comp.name}`);
        if (c.changeType === "deleted") t.deleted.add(`apexclass|${key(comp.name)}`);
        break;
      case "AgentMetadata": {
        const kind = comp.agentKind ?? "agent";
        const part =
          kind === "bot" || kind === "botVersion" || kind === "script"
            ? "agent"
            : kind === "planner"
              ? "planner"
              : kind === "topic"
                ? "topic"
                : kind === "action"
                  ? "action"
                  : kind;
        const noun =
          part === "agent"
            ? "agent"
            : part === "planner"
              ? "agent planner"
              : part === "topic"
                ? "topic"
                : "agent action";
        if (part === "agent" || part === "planner" || part === "topic" || part === "action") {
          t.agentParts.set(`${part}|${key(comp.name)}`, `${verb} ${noun} ${comp.name}`);
        }
        if (kind === "promptTemplate") {
          t.automation.set(`prompttemplate|${key(comp.name)}`, `${verb} prompt template ${comp.name}`);
        }
        break;
      }
      default:
        break;
    }
  }
  return t;
}

/** Why a change affects an agent action; empty when it doesn't. */
function reasonsFor(
  input: AgentAnalysisInput,
  t: Touched,
  ref: AgentActionRef,
  reach: { procedures: SaveProcedure[]; cycle?: string[] },
): string[] {
  const { model } = input;
  const reasons: string[] = [];
  const { agent, topic, action } = ref;
  const metadata =
    t.agentParts.get(`action|${key(action.name)}`) ??
    (topic ? t.agentParts.get(`topic|${key(topic.name)}`) : undefined) ??
    t.agentParts.get(`agent|${key(agent.name)}`) ??
    agent.planners.map((p) => t.agentParts.get(`planner|${key(p)}`)).find(Boolean);
  if (metadata) reasons.push(metadata);

  const target = actionTarget(model, action);
  const direct =
    target.name && (target.kind === "ApexClass" || target.kind === "Flow")
      ? t.automation.get(`${target.kind === "ApexClass" ? "apexclass" : "flow"}|${key(target.name)}`)
      : undefined;
  if (direct) reasons.push(`${direct} (what the action calls)`);
  const code = actionCode(model, action);
  const targetKey = target.name ? key(target.name) : "";
  for (const c of code.classes) {
    const what = t.automation.get(`apexclass|${c}`);
    if (what && c !== targetKey) reasons.push(`${what} (called by the action)`);
  }
  for (const f of code.flows) {
    const what = t.automation.get(`flow|${f}`);
    if (what && f !== targetKey) reasons.push(`${what} (called by the action)`);
  }
  if (target.kind === "PromptTemplate" && target.name) {
    const what = t.automation.get(`prompttemplate|${key(target.name)}`);
    if (what) reasons.push(`${what} (what the action calls)`);
  }

  for (const p of reach.procedures) {
    const onObject = t.objects.get(key(p.object));
    for (const what of onObject ?? []) reasons.push(`${what}, which applies when the action saves ${p.object}`);
    for (const s of p.steps) {
      const what = t.automation.get(`${s.automation.kind.toLowerCase()}|${key(s.automation.name)}`);
      if (what) reasons.push(`${what}, which runs when the action saves ${p.object} (${p.event})`);
    }
  }
  return uniq(reasons);
}

/** Save procedures reached from an action's writes, and the first cycle found on the way. */
function reachOf(input: AgentAnalysisInput, writes: Write[]): { procedures: SaveProcedure[]; cycle?: string[] } {
  const visited = new Map<string, SaveProcedure>();
  let cycle: string[] | undefined;
  let budget = 300;
  const visit = (object: string, event: SaveEvent, path: string[], depth: number, via?: AutomationRef) => {
    if (budget-- <= 0) return;
    const p = input.proc(object, event);
    const label = `${p.object} (${event})${via ? ` ← ${describeRef(via)}` : ""}`;
    const k = `${key(object)}|${event}`;
    if (path.some((x) => x.startsWith(`${key(object)}|`))) {
      cycle ??= [...path.map((x) => x.split("§")[1]!), label];
      return;
    }
    const first = !visited.has(k);
    visited.set(k, p);
    if (depth >= input.maxDepth || !first) return;
    for (const step of p.steps) {
      for (const w of step.writes) {
        const ev: SaveEvent = w.op === "upsert" ? "update" : w.op;
        visit(w.object, ev, [...path, `${k}§${label}`], depth + 1, step.automation);
      }
    }
  };
  for (const w of uniqBy(writes, (w) => `${key(w.object)}|${w.op}`)) {
    visit(w.object, w.op === "upsert" ? "update" : w.op, [], 0);
  }
  return { procedures: [...visited.values()], cycle };
}

/** Agent actions that a changed piece of agent metadata defines or contains. */
export function actionsForAgentChange(model: OrgModel, comp: ComponentRef): AgentActionRef[] {
  const name = key(comp.name);
  return allAgentActions(model).filter(({ agent, topic, action }) => {
    switch (comp.agentKind) {
      case "action":
        return key(action.name) === name;
      case "topic":
        return !!topic && key(topic.name) === name;
      case "planner":
        return agent.planners.some((p) => key(p) === name) || key(agent.name) === name;
      case "bot":
      case "botVersion":
      case "script":
        return key(agent.name) === name || agent.files.includes(comp.file);
      case "promptTemplate":
        return action.target !== undefined && key(action.target) === name;
      default:
        return false;
    }
  });
}

export interface AgentAnalysis {
  impacts: AgentImpact[];
  findings: Finding[];
  tests: SuggestedTest[];
}

/** Agent actions affected by the change, with findings and suggested tests. */
export function analyzeAgents(input: AgentAnalysisInput): AgentAnalysis {
  const { model } = input;
  const t = touched(input.changes);
  const impacts: AgentImpact[] = [];
  const findings: Finding[] = [];
  const tests: SuggestedTest[] = [];
  if (!model.agents.size) return { impacts, findings, tests };

  for (const ref of allAgentActions(model)) {
    const { agent, topic, action } = ref;
    const target = actionTarget(model, action);
    const writes = actionWrites(model, action);
    const reach = reachOf(input, writes);
    const reasons = reasonsFor(input, t, ref, reach);
    if (!reasons.length) continue;
    const coverage = testsFor(model, agent, action);
    const access = userAccess(model, action);
    const impact: AgentImpact = {
      agent: agent.name,
      agentLabel: agent.label,
      topic: topic?.name,
      action: action.name,
      actionLabel: action.label,
      target: { kind: target.kind, name: target.name, inProject: target.inProject },
      reasons,
      reaches: uniq(reach.procedures.map((p) => p.object)).sort(),
      cycle: reach.cycle,
      needs: access.needs,
      apexClass: access.apexClass,
      systemMode: access.systemMode,
      runsAs: runsAs(agent),
      tests: coverage.expecting,
      agentTests: coverage.ofAgent,
      confirmationRequired: !!action.confirmationRequired,
      files: uniq([action.file, ...(topic ? [topic.file] : []), agent.file, ...(target.file ? [target.file] : [])]),
    };
    impacts.push(impact);

    const where = `${agentLabel(agent)}${topic ? ` › ${topic.label ?? topic.name}` : ""}`;
    const name = `${actionLabel(action)} (${where})`;
    const deletedTarget =
      (target.kind === "ApexClass" && target.name && t.deleted.has(`apexclass|${key(target.name)}`)) ||
      (target.kind === "Flow" && target.name && t.deleted.has(`flow|${key(target.name)}`));
    if (deletedTarget) {
      findings.push({
        rule: "deleted-still-referenced",
        severity: "high",
        title: `Agent action ${name} calls deleted ${describeTarget(target)}`,
        detail: `The action fails every time the agent chooses it. Remove the action from the agent, or keep ${describeTarget(target)}.`,
        files: impact.files,
      });
      continue;
    }

    const saves = impact.reaches.length ? ` When it runs, it saves ${impact.reaches.join(", ")}.` : "";
    findings.push({
      rule: "agent-action-affected",
      severity: reach.cycle ? "high" : "medium",
      title: `Agent action ${name} is affected`,
      detail:
        `The action calls ${describeTarget(target)}. Affected by: ${reasons.join("; ")}.${saves}` +
        (reach.cycle
          ? ` Its saves run into an automation cycle (${reach.cycle.map((c) => c.split(" ")[0]).join(" → ")}), which agents can trigger far more often than people.`
          : "") +
        " An agent can't see errors the way a person does: verify the action still succeeds and reports failures.",
      files: impact.files,
    });
    if (!target.inProject && (target.kind === "ApexClass" || target.kind === "Flow")) {
      findings.push({
        rule: "agent-action-target-missing",
        severity: "low",
        title: `Agent action ${name} calls ${describeTarget(target)}, which isn't in the project`,
        detail:
          "Preflight can't follow what the action does. If the target lives only in the org or in a managed package, retrieve it to include it in the analysis.",
        files: impact.files,
      });
    }
    if (!impact.tests.length) {
      findings.push({
        rule: "agent-action-untested",
        severity: "low",
        title: `No Testing Center test expects agent action ${name}`,
        detail: impact.agentTests.length
          ? `${agentLabel(agent)} has tests (${impact.agentTests.join(", ")}), but none of their test cases expect ${actionLabel(action)}. Add a test case where a user asks for it, expecting ${topic ? `topic ${topic.name} and ` : ""}action ${action.name}.`
          : `${agentLabel(agent)} has no Testing Center tests in the project. Add a test definition with a test case that expects ${topic ? `topic ${topic.name} and ` : ""}action ${action.name}.`,
        files: impact.files,
      });
    }
    const deletes = uniq(writes.filter((w) => w.op === "delete").map((w) => w.object));
    if (deletes.length && !impact.confirmationRequired) {
      findings.push({
        rule: "agent-action-no-confirmation",
        severity: "medium",
        title: `Agent action ${name} deletes records without asking for confirmation`,
        detail: `It deletes ${deletes.join(", ")} records. Require confirmation for destructive actions so a misread request can't delete data.`,
        files: impact.files,
      });
    }
  }

  // Suggested tests, per agent.
  for (const agentName of uniq(impacts.map((i) => i.agent))) {
    const forAgent = impacts.filter((i) => i.agent === agentName);
    const agent = model.agents.get(key(agentName))!;
    const covering = uniq(forAgent.flatMap((i) => i.tests));
    const untested = forAgent.filter((i) => !i.tests.length);
    if (covering.length) {
      tests.push({
        kind: "agent",
        description: `Run the Testing Center tests that cover the affected actions of ${agentLabel(agent)} in a sandbox: ${covering.map((n) => `sf agent test run --api-name ${n} --wait 10 --target-org <sandbox>`).join("; ")}`,
        covers: forAgent.filter((i) => i.tests.length).map((i) => i.action),
      });
    }
    if (untested.length) {
      tests.push({
        kind: "agent",
        description: `Add Testing Center test cases for ${untested.map((i) => i.actionLabel ?? i.action).join(", ")} of ${agentLabel(agent)}: utterances that should choose each action, expecting its topic and action (start with \`sf agent generate test-spec\`).`,
        covers: untested.map((i) => i.action),
      });
    }
    if (agent.runtimeUser) {
      const needs = mergeNeeds(forAgent.flatMap((i) => i.needs));
      const classes = uniq(forAgent.map((i) => i.apexClass).filter((c): c is string => !!c));
      const what = [
        ...(classes.length ? [`access to Apex class${classes.length > 1 ? "es" : ""} ${classes.join(", ")}`] : []),
        ...(needs.length ? [describeNeeds(needs)] : []),
      ];
      if (what.length) {
        tests.push({
          kind: "permission-negative",
          description: `Run the affected actions as ${agentLabel(agent)}'s runtime user (System.runAs): it needs ${what.join(" and ")}, and nothing more.`,
          covers: forAgent.map((i) => i.action),
        });
      }
    }
  }
  return { impacts, findings, tests };
}

export function mergeNeeds(needs: AccessNeed[]): AccessNeed[] {
  const merged = new Map<string, AccessNeed>();
  for (const n of needs) {
    const m = merged.get(key(n.object)) ?? { object: n.object, access: [] };
    m.access = uniq([...m.access, ...n.access]);
    merged.set(key(n.object), m);
  }
  const order = ["create", "edit", "delete"];
  return [...merged.values()]
    .map((n) => ({ ...n, access: n.access.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }))
    .sort((a, b) => a.object.localeCompare(b.object));
}

export const describeNeeds = (needs: AccessNeed[]) =>
  needs.map((n) => `${n.access.length ? n.access.join("/") : "read"} on ${n.object}`).join(", ");

// ---------------------------------------------------------------------------------------
// Explaining an agent
// ---------------------------------------------------------------------------------------

export interface ActionExplanation {
  topic?: string;
  action: string;
  label?: string;
  description?: string;
  target: ActionTarget;
  confirmationRequired: boolean;
  /** Records the action saves directly, e.g. "Opportunity (update)". */
  writes: { object: string; op: DmlOp }[];
  /** Objects saved when it runs, including the automation that follows. */
  reaches: string[];
  cycle?: string[];
  needs: AccessNeed[];
  apexClass?: string;
  systemMode?: boolean;
  tests: string[];
}

export interface AgentExplanation {
  name: string;
  label?: string;
  source: AgentDef["source"];
  agentType?: string;
  runsAs: AgentImpact["runsAs"];
  topics: { name: string; label?: string; actions: number }[];
  actions: ActionExplanation[];
  tests: { name: string; testCases: number; topics: string[]; actions: string[] }[];
  files: string[];
}

/** Everything an agent can do: topics, actions, what they call and save, access and test coverage. */
export function explainAgent(model: OrgModel, name: string, maxDepth = 4): AgentExplanation | undefined {
  const agent = model.agents.get(key(name));
  if (!agent) return undefined;
  const cache = new Map<string, SaveProcedure>();
  const proc = (object: string, event: SaveEvent) => {
    const k = `${key(object)}|${event}`;
    if (!cache.has(k)) cache.set(k, saveProcedure(model, model.objects.get(key(object))?.name ?? object, event));
    return cache.get(k)!;
  };
  const input: AgentAnalysisInput = { model, changes: [], maxDepth, proc };
  const actions = agentActions(agent).map(({ topic, action }) => {
    const writes = actionWrites(model, action);
    const reach = reachOf(input, writes);
    const access = userAccess(model, action);
    return {
      topic: topic?.name,
      action: action.name,
      label: action.label,
      description: action.description,
      target: actionTarget(model, action),
      confirmationRequired: !!action.confirmationRequired,
      writes: uniqBy(
        writes.map((w) => ({ object: w.object, op: w.op })),
        (w) => `${key(w.object)}|${w.op}`,
      ),
      reaches: uniq(reach.procedures.map((p) => p.object)).sort(),
      cycle: reach.cycle,
      ...access,
      tests: testsFor(model, agent, action).expecting,
    };
  });
  return {
    name: agent.name,
    label: agent.label,
    source: agent.source,
    agentType: agent.agentType,
    runsAs: runsAs(agent),
    topics: agent.topics.map((t) => ({ name: t.name, label: t.label, actions: t.actions.length })),
    actions,
    tests: model.agentTests
      .filter((t) => key(t.subject) === key(agent.name))
      .map((t) => ({ name: t.name, testCases: t.testCases, topics: t.topics, actions: t.actions })),
    files: agent.files,
  };
}

/** One line per agent, for `preflight agents` without a name. */
export function agentListToMarkdown(model: OrgModel): string {
  if (!model.agents.size) return "No Agentforce agents found in the project.";
  const out = [
    "| Agent | Defined in | Topics | Actions | Runs as | Testing Center tests |",
    "|---|---|---|---|---|---|",
  ];
  for (const a of [...model.agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
    const tests = model.agentTests.filter((t) => key(t.subject) === key(a.name)).map((t) => t.name);
    out.push(
      `| \`${a.name}\`${a.label ? ` (${a.label})` : ""} | ${a.source === "AgentScript" ? "Agent Script" : "Agent Builder"} | ${a.topics.length} | ${agentActions(a).length} | ${runsAs(a) === "dedicated user" ? "own user" : "signed-in user"} | ${tests.join(", ") || "—"} |`,
    );
  }
  return out.join("\n");
}

/** Markdown for `preflight agents <name>` and the MCP explain_agent tool. */
export function agentExplanationToMarkdown(e: AgentExplanation): string {
  const out: string[] = [
    `## Agent: ${e.label ?? e.name}`,
    "",
    `\`${e.name}\` · ${e.source === "AgentScript" ? "Agent Script" : "Agent Builder metadata"}${e.agentType ? ` · ${e.agentType}` : ""} · runs as ${e.runsAs === "dedicated user" ? "its own runtime user" : "the signed-in user"}`,
    "",
  ];
  if (!e.actions.length) {
    out.push("_No actions found in the project._", "");
  } else {
    out.push("| Topic › Action | Calls | Saves | Runtime user needs | Testing Center |", "|---|---|---|---|---|");
    for (const a of e.actions) {
      const calls = `${describeTarget(a.target)}${a.target.inProject || a.target.kind === "Other" ? "" : " (not in project)"}`;
      const saves = a.reaches.length ? a.reaches.join(", ") : "—";
      const needs =
        [
          ...(a.apexClass ? [a.systemMode ? "class access (Apex saves in system mode)" : "class access"] : []),
          ...a.needs.map((n) => `${n.access.join("/") || "read"} ${n.object}`),
        ].join(", ") || "—";
      out.push(
        `| ${a.topic ? `${a.topic} › ` : ""}${a.label ?? a.action}${a.confirmationRequired ? " (asks to confirm)" : ""} | ${calls} | ${saves}${a.cycle ? " ⟲" : ""} | ${needs} | ${a.tests.length ? `✅ ${a.tests.join(", ")}` : "⚠️ not tested"} |`,
      );
    }
    out.push("");
    if (e.actions.some((a) => a.cycle)) {
      out.push("⟲ Its saves run into an automation cycle, which agents can trigger far more often than people.", "");
    }
  }
  if (e.tests.length) {
    out.push("Testing Center tests:", "");
    for (const t of e.tests) {
      out.push(
        `- \`${t.name}\`: ${t.testCases} test case(s)${t.actions.length ? `, expects ${t.actions.join(", ")}` : ""}`,
      );
    }
  } else {
    out.push("No Testing Center tests for this agent in the project.");
  }
  return out.join("\n");
}
