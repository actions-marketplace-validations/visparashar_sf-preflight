// SPDX-License-Identifier: Apache-2.0
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userAccess } from "../src/core/agentImpact.js";
import {
  type AgentDef,
  agentExplanationToMarkdown,
  agentListToMarkdown,
  analyze,
  explainAgent,
  loadProject,
  type OrgModel,
  run,
  toMarkdown,
} from "../src/core/index.js";
import {
  agentFileKind,
  emptyAgentMetadata,
  linkAgents,
  parseAgentScript,
  parseAgentTest,
  parseBot,
  parseBotVersion,
  parseGenAiFunction,
  parseGenAiPlugin,
  parsePlanner,
} from "../src/core/parsers/agents.js";
import { createMcpServer } from "../src/mcp.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const at = (rel: string) => path.join(FIXTURE, SRC, rel);
const analyzeFiles = (...rel: string[]) => run({ projectDir: FIXTURE, files: rel.map(at) });
const xml = (root: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://soap.sforce.com/2006/04/metadata">${body}</${root}>`;

let model: OrgModel;
beforeAll(() => {
  model = loadProject(FIXTURE);
});

describe("agent metadata paths", () => {
  it("classifies every Agentforce source file", () => {
    const kind = (p: string) => agentFileKind(p.split("/"));
    expect(kind(`${SRC}/bots/Sales_Agent/Sales_Agent.bot-meta.xml`)).toEqual({ kind: "bot", name: "Sales_Agent" });
    expect(kind(`${SRC}/bots/Sales_Agent/v2.botVersion-meta.xml`)).toEqual({ kind: "botVersion", name: "Sales_Agent" });
    expect(kind(`${SRC}/genAiPlannerBundles/P/P.genAiPlannerBundle`)).toEqual({ kind: "planner", name: "P" });
    expect(kind(`${SRC}/genAiPlanners/P.genAiPlanner-meta.xml`)).toEqual({ kind: "planner", name: "P" });
    expect(kind(`${SRC}/genAiPlugins/T.genAiPlugin-meta.xml`)).toEqual({ kind: "topic", name: "T" });
    expect(kind(`${SRC}/genAiFunctions/A/A.genAiFunction-meta.xml`)).toEqual({ kind: "action", name: "A" });
    expect(kind(`${SRC}/genAiFunctions/A/input/schema.json`)).toEqual({ kind: "action", name: "A" });
    expect(kind(`${SRC}/aiAuthoringBundles/S/S.agent`)).toEqual({ kind: "script", name: "S" });
    expect(kind(`${SRC}/aiEvaluationDefinitions/T.aiEvaluationDefinition-meta.xml`)).toEqual({
      kind: "test",
      name: "T",
    });
    expect(kind(`${SRC}/aiTestingDefinitions/T.aiTestingDefinition-meta.xml`)).toEqual({ kind: "test", name: "T" });
    expect(kind(`${SRC}/genAiPromptTemplates/P.genAiPromptTemplate-meta.xml`)).toEqual({
      kind: "promptTemplate",
      name: "P",
    });
    expect(kind(`${SRC}/classes/Bots.cls`)).toBeUndefined();
    // Only files a bundle can contain count, so a folder that happens to be named "bots" doesn't.
    expect(kind(`${SRC}/bots/Sales_Agent/notes.md`)).toBeUndefined();
  });
});

describe("agent metadata parsers", () => {
  it("reads actions, topics, planners, bots and versions", () => {
    expect(
      parseGenAiFunction(
        xml(
          "GenAiFunction",
          "<invocationTarget>Svc.run</invocationTarget><invocationTargetType>apex</invocationTargetType><isConfirmationRequired>true</isConfirmationRequired><masterLabel>Run</masterLabel>",
        ),
        "Run_It",
        "f",
      ),
    ).toEqual({
      name: "Run_It",
      label: "Run",
      description: undefined,
      targetType: "apex",
      target: "Svc",
      confirmationRequired: true,
      file: "f",
    });
    const topic = parseGenAiPlugin(
      xml(
        "GenAiPlugin",
        "<developerName>T</developerName><genAiFunctions><functionName>A</functionName></genAiFunctions><localActions><developerName>L</developerName><invocationTarget>F</invocationTarget><invocationTargetType>flow</invocationTargetType></localActions><localActionLinks><functionName>L</functionName></localActionLinks>",
      ),
      "T",
      "t",
    );
    expect(topic.refs).toEqual(["A", "L"]);
    expect(topic.local.map((a) => `${a.name}:${a.targetType}:${a.target}`)).toEqual(["L:flow:F"]);
    const planner = parsePlanner(
      xml(
        "GenAiPlannerBundle",
        "<genAiPlugins><genAiPluginName>T</genAiPluginName></genAiPlugins><localTopicLinks><genAiPluginName>LT</genAiPluginName></localTopicLinks><localTopics><developerName>LT</developerName><localActions><developerName>LA</developerName><invocationTarget>P</invocationTarget><invocationTargetType>generatePromptResponse</invocationTargetType></localActions></localTopics><genAiFunctions><genAiFunctionName>G</genAiFunctionName></genAiFunctions><plannerActions><developerName>PA</developerName><invocationTarget>X</invocationTarget><invocationTargetType>apex</invocationTargetType></plannerActions>",
      ),
      "P1",
      "p",
    );
    expect(planner.topicRefs).toEqual(["T", "LT"]);
    expect(planner.localTopics[0]!.local[0]).toMatchObject({ name: "LA", targetType: "generatePromptResponse" });
    expect(planner.actionRefs).toEqual(["G"]);
    expect(planner.localActions[0]).toMatchObject({ name: "PA", target: "X" });
    expect(
      parseBot(xml("Bot", "<label>L</label><botUser>u@x.com</botUser><agentType>T</agentType>"), "B", "b"),
    ).toEqual({ name: "B", label: "L", agentType: "T", runtimeUser: "u@x.com", file: "b" });
    expect(
      parseBotVersion(
        xml(
          "BotVersion",
          "<conversationDefinitionPlanners><genAiPlannerName>P1</genAiPlannerName></conversationDefinitionPlanners>",
        ),
      ),
    ).toEqual(["P1"]);
  });

  it("reads expected topics and actions from both Testing Center formats", () => {
    const legacy = parseAgentTest(
      xml(
        "AiEvaluationDefinition",
        "<subjectName>A</subjectName><testCase><expectation><name>topic_assertion</name><expectedValue>T1</expectedValue></expectation><expectation><name>actions_assertion</name><expectedValue>['X', 'Y']</expectedValue></expectation></testCase><testCase><expectation><name>action_sequence_match</name><expectedValue>[\"Z\"]</expectedValue></expectation></testCase>",
      ),
      "Legacy",
      "l",
    );
    expect(legacy).toMatchObject({ format: "AiEvaluationDefinition", subject: "A", testCases: 2, topics: ["T1"] });
    expect(legacy.actions).toEqual(["X", "Y", "Z"]);
    const ngt = parseAgentTest(
      xml(
        "AiTestingDefinition",
        "<subjectName>A</subjectName><testCase><scorer><name>topic_sequence_match</name><expectedValue>T2</expectedValue></scorer><scorer><name>action_sequence_match</name><expectedValue>['W']</expectedValue></scorer><scorer><name>coherence</name></scorer></testCase>",
      ),
      "Ngt",
      "n",
    );
    expect(ngt).toMatchObject({ format: "AiTestingDefinition", topics: ["T2"], actions: ["W"] });
  });

  it("reads Agent Script topics, subagents, actions and targets", () => {
    const agent = parseAgentScript(
      [
        "config:",
        '    developer_name: "Concierge"',
        '    agent_label: "Concierge"',
        '    default_agent_user: "bot@example.com"',
        "",
        "start_agent router:",
        "    reasoning:",
        "        actions:",
        "            go: @utils.transition to @subagent.Orders",
        "",
        "topic Orders:",
        '    label: "Orders"',
        "    actions:",
        "        Cancel_Order:",
        '            target: "apex://OrderService.cancel"',
        "            require_user_confirmation: True",
        "        Summarize:",
        '            target: "prompt://Order_Summary"',
        "    reasoning:",
        "        actions:",
        "            cancel: @actions.Cancel_Order",
        "",
        "subagent Returns:",
        "    actions:",
        "        Start_Return:",
        "            target: flow://Start_Return   # the main path",
      ].join("\n"),
      "concierge",
      "c.agent",
    );
    expect(agent).toMatchObject({ name: "Concierge", source: "AgentScript", runtimeUser: "bot@example.com" });
    expect(
      agent.topics.map((t) => `${t.name}:${t.actions.map((a) => `${a.name}=${a.targetType}:${a.target}`).join(",")}`),
    ).toEqual([
      "router:",
      "Orders:Cancel_Order=apex:OrderService,Summarize=prompt:Order_Summary",
      "Returns:Start_Return=flow:Start_Return",
    ]);
    expect(agent.topics[1]!.actions[0]!.confirmationRequired).toBe(true);
    expect(agent.employee).toBeUndefined();
    const employee = parseAgentScript(
      'config:\n    developer_name: "Helper"\n    agent_type: "AgentforceEmployeeAgent"\n    default_agent_user: "x@example.com"\n',
      "helper",
      "h.agent",
    );
    expect(employee.employee).toBe(true);
  });

  it("treats employee agents as running as the signed-in user", () => {
    const meta = emptyAgentMetadata();
    meta.bots.push(parseBot(xml("Bot", "<botUser>u@x.com</botUser><type>InternalCopilot</type>"), "Internal", "i"));
    meta.bots.push(parseBot(xml("Bot", "<botUser>u@x.com</botUser><type>ExternalCopilot</type>"), "External", "e"));
    const agents = linkAgents(meta, []);
    expect(agents.get("internal")!.employee).toBe(true);
    expect(agents.get("external")!.employee).toBeUndefined();
  });

  it("resolves local topics and actions by any of their names", () => {
    const planner = parsePlanner(
      xml(
        "GenAiPlannerBundle",
        "<localTopicLinks><genAiPluginName>Orders_16j</genAiPluginName></localTopicLinks><localTopics><developerName>Orders</developerName><fullName>Orders_16j</fullName><localActions><developerName>Cancel</developerName><fullName>Cancel_179</fullName><invocationTarget>C</invocationTarget><invocationTargetType>apex</invocationTargetType></localActions><localActionLinks><functionName>Cancel_179</functionName></localActionLinks></localTopics>",
      ),
      "P",
      "p",
    );
    const meta = emptyAgentMetadata();
    meta.planners.push(planner);
    const agent = linkAgents(meta, []).get("p")!;
    expect(agent.topics.map((t) => `${t.name}:${t.actions.map((a) => `${a.name}/${a.targetType}`).join(",")}`)).toEqual(
      ["Orders:Cancel/apex"],
    );
  });

  it("links bots to planners, topics and actions, and keeps unresolved references visible", () => {
    const meta = emptyAgentMetadata();
    meta.bots.push({ name: "B", file: "b" });
    meta.botVersions.push({ bot: "B", planners: ["P1", "Missing_Planner"], file: "v" });
    meta.planners.push(
      {
        name: "P1",
        localTopics: [],
        topicRefs: ["T", "Unknown_Topic"],
        localActions: [],
        actionRefs: ["G"],
        file: "p",
      },
      { name: "Orphan", localTopics: [], topicRefs: [], localActions: [], actionRefs: ["G"], file: "o" },
    );
    meta.topics.push({ name: "T", local: [], refs: ["A", "Nope"], file: "t" });
    meta.actions.push(
      { name: "A", targetType: "flow", target: "F", file: "a" },
      { name: "G", targetType: "apex", target: "C", file: "g" },
    );
    const warnings: string[] = [];
    const agents = linkAgents(meta, warnings);
    const b = agents.get("b")!;
    expect(b.topics.map((t) => `${t.name}:${t.actions.map((a) => `${a.name}/${a.targetType}`).join(",")}`)).toEqual([
      "T:A/flow,Nope/unknown",
      "Unknown_Topic:",
    ]);
    expect(b.actions.map((a) => a.name)).toEqual(["G"]);
    expect(b.files).toEqual(["b", "v", "p", "t", "a", "g"]);
    expect(agents.get("orphan")!.actions.map((a) => a.name)).toEqual(["G"]);
    expect(warnings).toEqual(["Agent planner Missing_Planner is referenced but not in the project."]);
  });
});

describe("agent action impact", () => {
  it("finds the agent actions a field change reaches", () => {
    const r = analyzeFiles("objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml");
    expect(r.agents.map((a) => `${a.agent}/${a.topic}/${a.action}`)).toEqual([
      "Sales_Agent/Close_Deals/Close_Opportunity",
    ]);
    const [impact] = r.agents;
    expect(impact).toMatchObject({
      target: { kind: "ApexClass", name: "OpportunityCloser", inProject: true },
      reasons: ["changed field Opportunity.Contract_Signed_Date__c, which applies when the action saves Opportunity"],
      reaches: ["Account", "Contact", "Opportunity", "Task"],
      needs: [],
      apexClass: "OpportunityCloser",
      systemMode: true,
      runsAs: "dedicated user",
      tests: [],
      agentTests: ["Sales_Agent_Tests"],
    });
    const affected = r.findings.find((f) => f.rule === "agent-action-affected")!;
    expect(affected.severity).toBe("high"); // its saves run into a cycle
    expect(affected.title).toBe("Agent action Close Opportunity (Sales Agent › Close Deals) is affected");
    expect(affected.detail).toContain("The action calls class OpportunityCloser. Affected by: changed field");
    const untested = r.findings.find((f) => f.rule === "agent-action-untested")!;
    expect(untested.detail).toContain("Sales Agent has tests (Sales_Agent_Tests), but none of their test cases expect");
    const agentTests = r.suggestedTests.filter((t) => t.kind === "agent");
    expect(agentTests.map((t) => t.description)).toEqual([
      "Add Testing Center test cases for Close Opportunity of Sales Agent: utterances that should choose each action, expecting its topic and action (start with `sf agent generate test-spec`).",
    ]);
    expect(r.suggestedTests.find((t) => t.description.includes("runtime user"))!.description).toContain(
      "it needs access to Apex class OpportunityCloser, and nothing more.",
    );
  });

  it("follows changes to the code an action calls, and to agent metadata", () => {
    const cls = analyzeFiles("classes/OpportunityCloser.cls");
    expect(cls.agents[0]!.reasons).toEqual(["changed class OpportunityCloser (what the action calls)"]);
    const action = analyzeFiles("genAiFunctions/Close_Opportunity/Close_Opportunity.genAiFunction-meta.xml");
    expect(action.agents[0]!.reasons).toEqual(["changed agent action Close_Opportunity"]);
    // A changed agent action roots the cascade at what it saves.
    expect(action.cascade.map((n) => `${n.object} (${n.event}) ← ${n.via?.name}`)).toEqual([
      "Opportunity (update) ← OpportunityCloser",
    ]);
    expect(action.findings.some((f) => f.rule === "recursion-cycle")).toBe(true);
    const topic = analyzeFiles("genAiPlugins/Close_Deals.genAiPlugin-meta.xml");
    expect(topic.agents.map((a) => a.action)).toEqual(["Close_Opportunity", "Log_Customer_Call"]);
    const covered = topic.agents.find((a) => a.action === "Log_Customer_Call")!;
    expect(covered.tests).toEqual(["Sales_Agent_Tests"]);
    expect(covered.needs).toEqual([{ object: "Task", access: ["create"] }]);
    expect(
      topic.suggestedTests.some((t) => t.description.includes("sf agent test run --api-name Sales_Agent_Tests")),
    ).toBe(true);
    const script = analyzeFiles("aiAuthoringBundles/Service_Agent/Service_Agent.agent");
    expect(script.agents.map((a) => `${a.agent}/${a.action}:${a.target.kind}:${a.target.name}`)).toEqual([
      "Service_Agent/Update_Tier:Flow:Update_Customer_Tier",
    ]);
    expect(script.findings.find((f) => f.rule === "agent-action-untested")!.detail).toContain(
      "Service Agent has no Testing Center tests in the project.",
    );
  });

  it("reaches actions of several agents through a shared object", () => {
    const r = analyzeFiles("objects/Account/validationRules/Tier_Required_For_Customers.validationRule-meta.xml");
    expect(r.agents.map((a) => a.action).sort()).toEqual(["Close_Opportunity", "Update_Tier"]);
    const md = toMarkdown(r);
    expect(md).toContain("### Agent actions");
    expect(md).toContain(
      "| Service Agent | Account_Care › Update Tier | flow `Update_Customer_Tier` | Account, Contact | edit Account | ⚠️ not tested |",
    );
    expect(md).toContain("class access (Apex saves in system mode)");
  });

  it("leaves unrelated changes and actions alone", () => {
    const r = analyzeFiles("objects/Contact/fields/Account_Tier__c.field-meta.xml");
    expect(r.agents.map((a) => a.action)).not.toContain("Log_Customer_Call");
    const none = analyzeFiles("permissionsets/Agent_Runtime_User.permissionset-meta.xml");
    expect(none.agents).toEqual([]);
    expect(toMarkdown(none)).not.toContain("### Agent actions");
  });
});

describe("agent changes in a scratch copy of the project", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-agents-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const d = path.join(dir, SRC);
    writeFileSync(
      path.join(d, "flows/Remove_Task.flow-meta.xml"),
      xml(
        "Flow",
        "<apiVersion>62.0</apiVersion><label>Remove Task</label><processType>AutoLaunchedFlow</processType><recordDeletes><name>Delete_It</name><label>Delete It</label><filters><field>Id</field><operator>EqualTo</operator><value><elementReference>recordId</elementReference></value></filters><object>Task</object></recordDeletes><start><connector><targetReference>Delete_It</targetReference></connector></start><status>Active</status>",
      ),
    );
    cpSync(path.join(d, "genAiFunctions/Log_Customer_Call"), path.join(d, "genAiFunctions/Remove_Task"), {
      recursive: true,
    });
    rmSync(path.join(d, "genAiFunctions/Remove_Task/Log_Customer_Call.genAiFunction-meta.xml"));
    writeFileSync(
      path.join(d, "genAiFunctions/Remove_Task/Remove_Task.genAiFunction-meta.xml"),
      xml(
        "GenAiFunction",
        "<invocationTarget>Remove_Task</invocationTarget><invocationTargetType>flow</invocationTargetType><masterLabel>Remove Task</masterLabel>",
      ),
    );
    writeFileSync(
      path.join(d, "genAiPlugins/Close_Deals.genAiPlugin-meta.xml"),
      xml(
        "GenAiPlugin",
        "<developerName>Close_Deals</developerName><masterLabel>Close Deals</masterLabel><genAiFunctions><functionName>Close_Opportunity</functionName></genAiFunctions><genAiFunctions><functionName>Remove_Task</functionName></genAiFunctions>",
      ),
    );
    mkdirSync(path.join(d, "genAiPromptTemplates"));
    writeFileSync(
      path.join(d, "genAiPromptTemplates/Unused.genAiPromptTemplate-meta.xml"),
      xml("GenAiPromptTemplate", "<masterLabel>Unused</masterLabel>"),
    );
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runIn = (...rel: string[]) => run({ projectDir: dir, files: rel.map((r) => path.join(dir, SRC, r)) });

  it("flags destructive actions that don't ask for confirmation", () => {
    const r = runIn("genAiFunctions/Remove_Task/Remove_Task.genAiFunction-meta.xml");
    const f = r.findings.find((x) => x.rule === "agent-action-no-confirmation")!;
    expect(f.title).toBe(
      "Agent action Remove Task (Sales Agent › Close Deals) deletes records without asking for confirmation",
    );
    expect(r.agents[0]!.needs).toEqual([{ object: "Task", access: ["delete"] }]);
  });

  it("reports agent metadata no agent uses", () => {
    const r = runIn("genAiPromptTemplates/Unused.genAiPromptTemplate-meta.xml");
    expect(r.findings.map((f) => `${f.rule}: ${f.title}`)).toContain(
      "agent-metadata-changed: Agentforce metadata changed: Unused",
    );
  });

  it("never quotes agent files in parse warnings", () => {
    const bot = path.join(dir, SRC, "bots/Broken_Agent/Broken_Agent.bot-meta.xml");
    mkdirSync(path.dirname(bot), { recursive: true });
    writeFileSync(bot, '<?xml version="1.0"?><Bot><label>B</label><botUser note="x>owner@acmecorp</botUser></Bot>');
    const m = loadProject(dir);
    expect(m.warnings).toContain(`Could not parse ${SRC}/bots/Broken_Agent/Broken_Agent.bot-meta.xml.`);
    expect(m.warnings.join("\n")).not.toContain("acmecorp");
    rmSync(path.dirname(bot), { recursive: true });
  });

  it("flags actions whose class or flow is deleted", () => {
    const file = `${SRC}/flows/Remove_Task.flow-meta.xml`;
    rmSync(path.join(dir, file));
    const r = analyze({
      model: loadProject(dir),
      changes: [{ changeType: "deleted", component: { type: "Flow", name: "Remove_Task", file } }],
    });
    const f = r.findings.find((x) => x.rule === "deleted-still-referenced")!;
    expect(f.severity).toBe("high");
    expect(f.title).toBe("Agent action Remove Task (Sales Agent › Close Deals) calls deleted flow Remove_Task");
  });

  it("flags deleted actions and topics an agent still uses", () => {
    const actionFile = `${SRC}/genAiFunctions/Remove_Task/Remove_Task.genAiFunction-meta.xml`;
    rmSync(path.join(dir, SRC, "genAiFunctions/Remove_Task"), { recursive: true });
    const action = analyze({
      model: loadProject(dir),
      changes: [
        {
          changeType: "deleted",
          component: { type: "AgentMetadata", agentKind: "action", name: "Remove_Task", file: actionFile },
        },
      ],
    });
    expect(action.findings.map((f) => `${f.severity}:${f.rule}:${f.title}`)).toEqual([
      "high:deleted-still-referenced:Deleted agent action Remove_Task is still used by Sales Agent › Close Deals",
    ]);
    const topicFile = `${SRC}/genAiPlugins/Close_Deals.genAiPlugin-meta.xml`;
    rmSync(path.join(dir, topicFile));
    const topic = analyze({
      model: loadProject(dir),
      changes: [
        {
          changeType: "deleted",
          component: { type: "AgentMetadata", agentKind: "topic", name: "Close_Deals", file: topicFile },
        },
      ],
    });
    expect(topic.findings.map((f) => `${f.severity}:${f.rule}:${f.title}`)).toEqual([
      "high:deleted-still-referenced:Deleted topic Close_Deals is still used by agent Sales Agent",
    ]);
  });
});

describe("explaining agents", () => {
  it("lists agents and explains one", () => {
    expect(agentListToMarkdown(model)).toContain(
      "| `Service_Agent` (Service Agent) | Agent Script | 2 | 1 | own user | — |",
    );
    const e = explainAgent(model, "sales_agent")!;
    expect(e.actions.map((a) => `${a.action}:${a.writes.map((w) => `${w.object}/${w.op}`).join(",")}`)).toEqual([
      "Close_Opportunity:Opportunity/update",
      "Log_Customer_Call:Task/insert",
    ]);
    const md = agentExplanationToMarkdown(e);
    expect(md).toContain("## Agent: Sales Agent");
    expect(md).toContain(
      "| Close_Deals › Log Customer Call | flow Log_Customer_Call | Task | create Task | ✅ Sales_Agent_Tests |",
    );
    expect(md).toContain("- `Sales_Agent_Tests`: 1 test case(s), expects Log_Customer_Call");
    expect(md).not.toContain("example.com");
    expect(explainAgent(model, "Nope")).toBeUndefined();
  });

  it("counts object access for Apex only when it uses user-mode DML", () => {
    const m = loadProject(FIXTURE);
    const cls = m.classes.get("opportunitycloser")!;
    const action = (m.agents.get("sales_agent") as AgentDef).topics[0]!.actions[0]!;
    // Secured reads don't make the DML run as the user.
    m.classes.set("opportunitycloser", {
      ...cls,
      stripped: `${cls.stripped}\n[SELECT Id FROM Account WITH SECURITY_ENFORCED];`,
    });
    expect(userAccess(m, action)).toEqual({ needs: [], apexClass: "OpportunityCloser", systemMode: true });
    m.classes.set("opportunitycloser", { ...cls, stripped: `${cls.stripped}\nupdate as user opps;` });
    expect(userAccess(m, action)).toEqual({
      needs: [{ object: "Opportunity", access: ["edit"] }],
      apexClass: "OpportunityCloser",
      systemMode: undefined,
    });
  });

  it("needs no object access for flows that run in system mode", () => {
    const m = loadProject(FIXTURE);
    const action = (m.agents.get("service_agent") as AgentDef).topics[1]!.actions[0]!;
    expect(userAccess(m, action).needs).toEqual([{ object: "Account", access: ["edit"] }]);
    m.flows.get("update_customer_tier")!.runInMode = "SystemModeWithoutSharing";
    expect(userAccess(m, action).needs).toEqual([]);
  });
});

describe("MCP explain_agent", () => {
  let client: Client;
  beforeAll(async () => {
    const server = createMcpServer({ root: FIXTURE, version: "0.0.0-test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterAll(async () => client.close());

  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "explain_agent", arguments: args });
    return { error: !!res.isError, text: (res.content as { text: string }[])[0]!.text };
  };

  it("lists agents, explains one and reports unknown names", async () => {
    expect((await call({})).text).toContain("`Sales_Agent` (Sales Agent)");
    expect((await call({ agent: "Service_Agent" })).text).toContain(
      "| Account_Care › Update Tier | flow Update_Customer_Tier |",
    );
    expect(await call({ agent: "Nope" })).toEqual({
      error: true,
      text: "preflight: No agent named Nope in the project.",
    });
  });
});
