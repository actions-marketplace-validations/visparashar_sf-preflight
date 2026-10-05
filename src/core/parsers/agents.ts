// SPDX-License-Identifier: Apache-2.0
import type { AgentAction, AgentDef, AgentFileKind, AgentTestDef, AgentTopic } from "../types.js";
import { bool, key, nodes, parseMetadataXml, text, uniq, uniqBy, type XmlNode } from "../util.js";

/**
 * Agentforce metadata in SFDX source format:
 *
 *   bots/<Agent>/<Agent>.bot-meta.xml                      agent (Bot): type, runtime user
 *   bots/<Agent>/v1.botVersion-meta.xml                    version → planner bundle
 *   genAiPlannerBundles/<Planner>/<Planner>.genAiPlannerBundle   topics and actions of the agent
 *   genAiPlanners/<Planner>.genAiPlanner-meta.xml          older planner format
 *   genAiPlugins/<Topic>.genAiPlugin-meta.xml              topic → actions
 *   genAiFunctions/<Action>/<Action>.genAiFunction-meta.xml      action → invocation target
 *   aiAuthoringBundles/<Agent>/<Agent>.agent               Agent Script: the whole agent in one file
 *   aiEvaluationDefinitions/<Test>.aiEvaluationDefinition-meta.xml   Testing Center test
 *   aiTestingDefinitions/<Test>.aiTestingDefinition-meta.xml         Testing Center test (newer)
 */

/** Folder → kind for bundle-style types, where every file in `<folder>/<Name>/` belongs to `Name`. */
const BUNDLE_FOLDERS: Record<string, AgentFileKind> = {
  bots: "bot",
  genAiPlannerBundles: "planner",
  genAiFunctions: "action",
  aiAuthoringBundles: "script",
};

const SUFFIXES: [string, AgentFileKind][] = [
  [".genAiPlugin-meta.xml", "topic"],
  [".genAiPlanner-meta.xml", "planner"],
  [".aiEvaluationDefinition-meta.xml", "test"],
  [".aiTestingDefinition-meta.xml", "test"],
  [".genAiPromptTemplate-meta.xml", "promptTemplate"],
];

/** Classify an Agentforce metadata path; undefined for anything else. */
export function agentFileKind(parts: string[]): { kind: AgentFileKind; name: string } | undefined {
  const base = parts[parts.length - 1] ?? "";
  for (let i = parts.length - 3; i >= 0; i--) {
    const kind = BUNDLE_FOLDERS[parts[i]!];
    if (kind) {
      const name = parts[i + 1]!;
      if (kind === "bot" && base.endsWith(".botVersion-meta.xml")) return { kind: "botVersion", name };
      return { kind, name };
    }
  }
  for (const [suffix, kind] of SUFFIXES) {
    if (base.endsWith(suffix)) return { kind, name: base.slice(0, -suffix.length) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// XML metadata
// ---------------------------------------------------------------------------------------

const nameOf = (n: XmlNode) => text(n.developerName) ?? text(n.fullName) ?? text(n.localDeveloperName);

/** "apex" targets name a class; Agent Builder sometimes stores "Class.method". */
function normalizeTarget(type: string, target: string | undefined): string | undefined {
  if (!target) return undefined;
  if (type === "apex" && target.includes(".")) return target.slice(0, target.indexOf("."));
  return target;
}

function actionFrom(n: XmlNode, fallbackName: string, file: string): AgentAction {
  const targetType = text(n.invocationTargetType) ?? "unknown";
  return {
    name: nameOf(n) ?? fallbackName,
    label: text(n.masterLabel),
    description: text(n.description),
    targetType,
    target: normalizeTarget(targetType, text(n.invocationTarget)),
    confirmationRequired: bool(n.isConfirmationRequired) || undefined,
    file,
  };
}

/** `genAiFunctions/<Name>/<Name>.genAiFunction-meta.xml` */
export function parseGenAiFunction(xml: string, name: string, file: string): AgentAction {
  return { ...actionFrom(parseMetadataXml(xml).body, name, file), name };
}

/** A topic before its action references are resolved. */
export interface ParsedTopic {
  name: string;
  label?: string;
  /** Actions defined inside the topic. */
  local: AgentAction[];
  /** Names of actions defined elsewhere (GenAiFunction or the topic's local actions). */
  refs: string[];
  file: string;
}

function topicFrom(n: XmlNode, fallbackName: string, file: string): ParsedTopic {
  return {
    name: nameOf(n) ?? fallbackName,
    label: text(n.masterLabel),
    local: nodes(n.localActions).map((a, i) => actionFrom(a, `${fallbackName}_action_${i + 1}`, file)),
    refs: uniq(
      [...nodes(n.genAiFunctions), ...nodes(n.localActionLinks)]
        .map((r) => text(r.functionName) ?? text(r.genAiFunctionName))
        .filter((r): r is string => !!r),
    ),
    file,
  };
}

/** `genAiPlugins/<Name>.genAiPlugin-meta.xml` */
export function parseGenAiPlugin(xml: string, name: string, file: string): ParsedTopic {
  return { ...topicFrom(parseMetadataXml(xml).body, name, file), name };
}

/** A planner (the agent's reasoning engine configuration) before references are resolved. */
export interface ParsedPlanner {
  name: string;
  label?: string;
  localTopics: ParsedTopic[];
  topicRefs: string[];
  localActions: AgentAction[];
  actionRefs: string[];
  file: string;
}

/** `genAiPlannerBundles/<Name>/<Name>.genAiPlannerBundle` or `genAiPlanners/<Name>.genAiPlanner-meta.xml` */
export function parsePlanner(xml: string, name: string, file: string): ParsedPlanner {
  const { body } = parseMetadataXml(xml);
  const refs = (v: unknown, field: string) =>
    nodes(v)
      .map((r) => text(r[field]))
      .filter((r): r is string => !!r);
  return {
    name,
    label: text(body.masterLabel),
    localTopics: nodes(body.localTopics).map((t, i) => topicFrom(t, `${name}_topic_${i + 1}`, file)),
    topicRefs: uniq([...refs(body.genAiPlugins, "genAiPluginName"), ...refs(body.localTopicLinks, "genAiPluginName")]),
    localActions: nodes(body.plannerActions).map((a, i) => actionFrom(a, `${name}_action_${i + 1}`, file)),
    actionRefs: uniq([
      ...refs(body.genAiFunctions, "genAiFunctionName"),
      ...refs(body.localActionLinks, "genAiFunctionName"),
    ]),
    file,
  };
}

export interface ParsedBot {
  name: string;
  label?: string;
  agentType?: string;
  runtimeUser?: string;
  file: string;
}

/** `bots/<Name>/<Name>.bot-meta.xml` */
export function parseBot(xml: string, name: string, file: string): ParsedBot {
  const { body } = parseMetadataXml(xml);
  return {
    name,
    label: text(body.label),
    agentType: text(body.agentType),
    runtimeUser: text(body.botUser),
    file,
  };
}

/** `bots/<Name>/<version>.botVersion-meta.xml` → the planners it uses. */
export function parseBotVersion(xml: string): string[] {
  const { body } = parseMetadataXml(xml);
  return nodes(body.conversationDefinitionPlanners)
    .map((p) => text(p.genAiPlannerName))
    .filter((p): p is string => !!p);
}

/** Names in an expected value such as "Close_Deals", "['A','B']" or "A, B". */
function namesIn(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[[\],'"\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z][\w.]*$/.test(s));
}

/** `aiEvaluationDefinitions/*.aiEvaluationDefinition-meta.xml` or `aiTestingDefinitions/*.aiTestingDefinition-meta.xml` */
export function parseAgentTest(xml: string, name: string, file: string): AgentTestDef {
  const { root, body } = parseMetadataXml(xml);
  const cases = nodes(body.testCase);
  const checks = cases.flatMap((c) => [...nodes(c.expectation), ...nodes(c.scorer)]);
  const expected = (names: string[]) =>
    uniq(checks.filter((e) => names.includes(text(e.name) ?? "")).flatMap((e) => namesIn(text(e.expectedValue))));
  return {
    name,
    format: root === "AiTestingDefinition" ? "AiTestingDefinition" : "AiEvaluationDefinition",
    subject: text(body.subjectName) ?? "",
    testCases: cases.length,
    topics: expected(["topic_sequence_match", "topic_assertion"]),
    actions: expected(["action_sequence_match", "actions_assertion", "action_assertion"]),
    file,
  };
}

// ---------------------------------------------------------------------------------------
// Agent Script (.agent)
// ---------------------------------------------------------------------------------------

interface ScriptLine {
  indent: number;
  key: string;
  value: string;
  children: ScriptLine[];
}

/** Indentation tree of `key: value` lines; enough structure to find topics, actions and targets. */
function scriptTree(source: string): ScriptLine[] {
  const roots: ScriptLine[] = [];
  const stack: ScriptLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const content = raw.trimStart();
    if (!content || content.startsWith("#")) continue;
    const indent = raw.length - content.length;
    const colon = content.indexOf(":");
    const line: ScriptLine = {
      indent,
      key: colon > 0 ? content.slice(0, colon).trim() : content.trim(),
      value: colon > 0 ? content.slice(colon + 1).trim() : "",
      children: [],
    };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1]!.children.push(line);
    else roots.push(line);
    stack.push(line);
  }
  return roots;
}

const unquote = (v: string) => v.replace(/^["']|["']$/g, "");
const child = (n: ScriptLine, k: string) => n.children.find((c) => c.key === k);

const SCHEMES: Record<string, string> = { apex: "apex", flow: "flow", prompt: "prompt" };

/** Parse an Agent Script file (`aiAuthoringBundles/<Name>/<Name>.agent`). */
export function parseAgentScript(source: string, name: string, file: string): AgentDef {
  const tree = scriptTree(source);
  const config = tree.find((n) => n.key === "config");
  const setting = (k: string) => (config ? unquote(child(config, k)?.value ?? "") || undefined : undefined);
  const topics: AgentTopic[] = [];
  for (const block of tree) {
    const m = /^(start_agent|topic|subagent)\s+([A-Za-z_]\w*)$/.exec(block.key);
    if (!m) continue;
    const actions: AgentAction[] = [];
    for (const def of child(block, "actions")?.children ?? []) {
      const target = unquote(child(def, "target")?.value ?? "");
      const t = /^([A-Za-z]+):\/\/([\w.]+)$/.exec(target);
      const targetType = t ? (SCHEMES[t[1]!.toLowerCase()] ?? t[1]!) : "unknown";
      actions.push({
        name: def.key,
        label: unquote(child(def, "label")?.value ?? "") || undefined,
        description: unquote(child(def, "description")?.value ?? "") || undefined,
        targetType,
        target: t ? normalizeTarget(targetType, t[2]) : undefined,
        confirmationRequired:
          /^true$/i.test(child(def, "require_user_confirmation")?.value ?? "") ||
          /^true$/i.test(child(def, "requires_confirmation")?.value ?? "") ||
          undefined,
        file,
      });
    }
    topics.push({
      name: m[2]!,
      label: unquote(child(block, "label")?.value ?? "") || undefined,
      actions,
      file,
    });
  }
  return {
    name: setting("developer_name") ?? name,
    label: setting("agent_label"),
    source: "AgentScript",
    agentType: setting("agent_type"),
    runtimeUser: setting("default_agent_user"),
    topics,
    actions: [],
    planners: [],
    file,
    files: [file],
  };
}

// ---------------------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------------------

export interface ParsedAgentMetadata {
  bots: ParsedBot[];
  /** Bot name → planners from its versions, with the version files. */
  botVersions: { bot: string; planners: string[]; file: string }[];
  planners: ParsedPlanner[];
  topics: ParsedTopic[];
  actions: AgentAction[];
  scripts: AgentDef[];
}

export function emptyAgentMetadata(): ParsedAgentMetadata {
  return { bots: [], botVersions: [], planners: [], topics: [], actions: [], scripts: [] };
}

/**
 * Resolve bots → planners → topics → actions. Planners without a bot in the project become
 * agents of their own; references to topics or actions that aren't in the project are kept as
 * actions of type "unknown" so they still show up.
 */
export function linkAgents(parsed: ParsedAgentMetadata, warnings: string[]): Map<string, AgentDef> {
  const actions = new Map(parsed.actions.map((a) => [key(a.name), a]));
  const topics = new Map(parsed.topics.map((t) => [key(t.name), t]));
  const planners = new Map(parsed.planners.map((p) => [key(p.name), p]));
  const missing = (name: string, file: string): AgentAction => ({ name, targetType: "unknown", file });

  const resolveTopic = (t: ParsedTopic): AgentTopic => {
    const local = new Map(t.local.map((a) => [key(a.name), a]));
    const resolved = t.refs.map((r) => local.get(key(r)) ?? actions.get(key(r)) ?? missing(r, t.file));
    return {
      name: t.name,
      label: t.label,
      actions: uniqBy([...t.local, ...resolved], (a) => key(a.name)),
      file: t.file,
    };
  };

  const fromPlanners = (names: string[]) => {
    const out = { topics: [] as AgentTopic[], actions: [] as AgentAction[], files: [] as string[] };
    for (const name of names) {
      const p = planners.get(key(name));
      if (!p) {
        warnings.push(`Agent planner ${name} is referenced but not in the project.`);
        continue;
      }
      out.files.push(p.file);
      const local = new Map(p.localTopics.map((t) => [key(t.name), t]));
      for (const t of p.localTopics) out.topics.push(resolveTopic(t));
      for (const ref of p.topicRefs) {
        if (local.has(key(ref))) continue;
        const t = topics.get(key(ref));
        if (t) {
          out.topics.push(resolveTopic(t));
          out.files.push(t.file);
        } else {
          out.topics.push({ name: ref, actions: [], file: p.file });
        }
      }
      const localActions = new Map(p.localActions.map((a) => [key(a.name), a]));
      out.actions.push(
        ...p.localActions,
        ...p.actionRefs.filter((r) => !localActions.has(key(r))).map((r) => actions.get(key(r)) ?? missing(r, p.file)),
      );
    }
    for (const t of out.topics) out.files.push(...t.actions.map((a) => a.file));
    out.files.push(...out.actions.map((a) => a.file));
    return out;
  };

  const agents = new Map<string, AgentDef>();
  const usedPlanners = new Set<string>();
  for (const bot of parsed.bots) {
    const versions = parsed.botVersions.filter((v) => key(v.bot) === key(bot.name));
    const plannerNames = uniq(versions.flatMap((v) => v.planners));
    for (const p of plannerNames) usedPlanners.add(key(p));
    const resolved = fromPlanners(plannerNames);
    agents.set(key(bot.name), {
      name: bot.name,
      label: bot.label,
      source: "Bot",
      agentType: bot.agentType,
      runtimeUser: bot.runtimeUser,
      topics: uniqBy(resolved.topics, (t) => key(t.name)),
      actions: uniqBy(resolved.actions, (a) => key(a.name)),
      planners: plannerNames,
      file: bot.file,
      files: uniq([bot.file, ...versions.map((v) => v.file), ...resolved.files]),
    });
  }
  for (const p of parsed.planners) {
    if (usedPlanners.has(key(p.name)) || agents.has(key(p.name))) continue;
    const resolved = fromPlanners([p.name]);
    agents.set(key(p.name), {
      name: p.name,
      label: p.label,
      source: "Bot",
      topics: uniqBy(resolved.topics, (t) => key(t.name)),
      actions: uniqBy(resolved.actions, (a) => key(a.name)),
      planners: [p.name],
      file: p.file,
      files: uniq([p.file, ...resolved.files]),
    });
  }
  for (const s of parsed.scripts) agents.set(key(s.name), s);
  return agents;
}

/** Every action an agent can use, with the topic it belongs to (undefined for agent-level actions). */
export function agentActions(agent: AgentDef): { topic?: AgentTopic; action: AgentAction }[] {
  return [
    ...agent.topics.flatMap((topic) => topic.actions.map((action) => ({ topic, action }))),
    ...agent.actions.map((action) => ({ action })),
  ];
}
