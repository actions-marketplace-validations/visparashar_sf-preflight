// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyRollback,
  changeAt,
  classifyError,
  cleanSubject,
  collectIncidents,
  createSfRunner,
  type ErrorVocabulary,
  groupIncidents,
  importErrors,
  incidentsToMarkdown,
  investigateIncidents,
  loadProject,
  mergeVocabulary,
  type OrgModel,
  parseCsv,
  parseSince,
  parseStack,
  planRollback,
  recentChanges,
  rollbackToMarkdown,
  SfError,
  type SfRunner,
  traceIncidents,
  vocabularyFromModel,
} from "../src/core/index.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";

let model: OrgModel;
let vocab: ErrorVocabulary;
beforeAll(() => {
  model = loadProject(FIXTURE);
  vocab = vocabularyFromModel(model);
});

const LEAKS = /Acme|jane|006[A-Za-z0-9]{12}|48,000/;

describe("classifying error messages", () => {
  it("names the validation rule whose message it is, without keeping the message", () => {
    const s = classifyError(
      "Update failed. First exception on row 0 with id 006000000000001AAA; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Enter the contract signed date before closing the deal.: [Contract_Signed_Date__c] (Acme, jane@acme.com)",
      vocab,
      "System.DmlException",
    );
    expect(s).toEqual({
      category: "validation",
      exceptionType: "System.DmlException",
      statusCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION",
      validationRules: ["Opportunity.Require_Contract_Signed_Date"],
      fields: ["Opportunity.Contract_Signed_Date__c"],
      triggers: [],
    });
    expect(JSON.stringify(s)).not.toMatch(LEAKS);
  });

  it("matches a rule only by its whole message, and names every rule that shares it", () => {
    const v = mergeVocabulary(vocab, {
      validationRules: [
        { name: "Opportunity.Short", message: "Invalid" },
        { name: "Quote.Discount_Region", message: "Invalid discount for this region" },
        { name: "Account.Required_A", message: "This field is required." },
        { name: "Contact.Required_B", message: "This field is required." },
      ],
    });
    const rules = (m: string) => classifyError(m, v).validationRules;
    expect(rules("FIELD_CUSTOM_VALIDATION_EXCEPTION, Invalid discount for this region: [Discount]")).toEqual([
      "Quote.Discount_Region",
    ]);
    expect(rules("FIELD_CUSTOM_VALIDATION_EXCEPTION, Invalid")).toEqual(["Opportunity.Short"]);
    expect(rules("FIELD_CUSTOM_VALIDATION_EXCEPTION, Invalidated by import")).toEqual([]);
    expect(
      rules(
        "first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, This field is required. You can look up ExceptionCode values",
      ),
    ).toEqual(["Account.Required_A", "Contact.Required_B"]);
    // Without the status code it isn't a validation rule's message.
    expect(rules("Invalid discount for this region")).toEqual([]);
  });

  it("reports the cause inside a wrapped error, and the trigger it came from", () => {
    const s = classifyError(
      "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, ContactTrigger: execution of AfterUpdate caused by: System.LimitException: Too many SOQL queries: 101",
      vocab,
    );
    expect(s).toMatchObject({
      category: "soql-limit",
      statusCode: "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
      exceptionType: "System.LimitException",
      triggers: ["ContactTrigger"],
    });
  });

  it("keeps only names the project knows, and only known status codes", () => {
    const s = classifyError(
      "REQUIRED_FIELD_MISSING, Required fields are missing: [Customer_Tier__c, Secret_Name, ACME_HOLDINGS]: ACME_HOLDINGS_LTD",
      vocab,
    );
    expect(s).toMatchObject({
      category: "required-field",
      statusCode: "REQUIRED_FIELD_MISSING",
      fields: ["Account.Customer_Tier__c"],
    });
    expect(JSON.stringify(s)).not.toMatch(/ACME|Secret/);
    expect(classifyError("No such column 'Account_Tier__c' on entity 'Contact'.", vocab).fields).toEqual([
      "Contact.Account_Tier__c",
    ]);
    expect(classifyError(undefined, vocab)).toEqual({
      category: "other",
      validationRules: [],
      fields: [],
      triggers: [],
    });
  });

  it("recognises messages of rules from the change history", () => {
    const v = mergeVocabulary(vocab, { validationRules: [{ name: "Opportunity.Old_Rule", message: "Old & gone." }] });
    expect(classifyError("FIELD_CUSTOM_VALIDATION_EXCEPTION: Old &  gone.", v).validationRules).toEqual([
      "Opportunity.Old_Rule",
    ]);
  });
});

describe("parsing", () => {
  it("parses --since", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    expect(parseSince("24h", now).toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(parseSince("2w", now).toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(parseSince("2026-10-01").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // Times without an offset are UTC, whatever the machine's time zone.
    expect(parseSince("2026-10-01T08:00").toISOString()).toBe("2026-10-01T08:00:00.000Z");
    expect(parseSince("2026-10-01T08:00+02:00").toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(() => parseSince("yesterday")).toThrow("duration");
    expect(() => parseSince("999d")).toThrow("between");
  });

  it("parses CSV with quoted commas, quotes and newlines", () => {
    expect(parseCsv('"A","B"\r\n"x, y","say ""hi""\nthere"\n')).toEqual([{ A: "x, y", B: 'say "hi"\nthere' }]);
  });

  it("reads Apex stack traces", () => {
    const stack =
      "Class.OpportunityCloser.close: line 12, column 1\nClass.OpportunityCloser.run: line 3\nTrigger.ContactTrigger: line 3, column 1\nClass.ns.Helper.go: line 1\nAnonymousBlock: line 1";
    expect(parseStack(stack, model)).toEqual([
      { kind: "ApexClass", name: "OpportunityCloser" },
      { kind: "ApexTrigger", name: "ContactTrigger" },
      { kind: "ApexClass", name: "ns.Helper" },
    ]);
  });
});

function fakeOrg(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[][] = [];
  const csv = [
    '"EVENT_TYPE","TIMESTAMP","USER_ID","EXCEPTION_TYPE","EXCEPTION_MESSAGE","STACK_TRACE","TIMESTAMP_DERIVED"',
    '"ApexUnexpectedException","20261005093000.000","005000000000001","System.NullPointerException","Attempt to de-reference a null object for Acme","Class.OpportunityCloser.close: line 12, column 1\nClass.OpportunityCloser.run: line 3, column 1","2026-10-05T09:30:00.000Z"',
    '"ApexUnexpectedException","20261005103000.000","005000000000001","System.NullPointerException","Attempt to de-reference a null object for jane@acme.com","Class.OpportunityCloser.close: line 12, column 1","2026-10-05T10:30:00.000Z"',
  ].join("\n");
  const hourlyCsv = [
    '"EVENT_TYPE","TIMESTAMP","USER_ID","EXCEPTION_TYPE","EXCEPTION_MESSAGE","STACK_TRACE","TIMESTAMP_DERIVED"',
    '"ApexUnexpectedException","20261006011500.000","005000000000001","System.LimitException","Too many SOQL queries: 101","Class.ContactTriggerHandler.handle: line 4, column 1\nTrigger.ContactTrigger: line 3, column 1","2026-10-06T01:15:00.000Z"',
  ].join("\n");
  const runner = ((args: string[], opts?: { raw?: boolean }) => {
    calls.push(args);
    const cmd = args.slice(0, 3).join(" ");
    if (cmd.startsWith("org display")) return { alias: "prod" };
    if (cmd === "sobject describe --sobject") {
      const sobject = args[3];
      if (sobject === "FlowInterview") {
        if (overrides.noFailedInterviews) {
          return { fields: [{ name: "InterviewStatus", type: "picklist", picklistValues: [{ value: "Paused" }] }] };
        }
        return {
          fields: [
            { name: "InterviewStatus", type: "picklist", picklistValues: [{ value: "Paused" }, { value: "Error" }] },
            { name: "FlowVersionViewId", type: "reference" },
            { name: "CurrentElement", type: "string" },
            { name: "InterviewLabel", type: "string" },
            { name: "CreatedDate", type: "datetime" },
            { name: "Error", type: "textarea" },
          ],
        };
      }
      if (sobject === "ssot__AiAgentInteractionStep__dlm" && overrides.agent) {
        return {
          fields: [
            { name: "ssot__Name__c", type: "string" },
            { name: "ssot__AiAgentInteractionStepType__c", type: "string" },
            { name: "ssot__ErrorMessageText__c", type: "string" },
            { name: "ssot__StartTimestamp__c", type: "datetime" },
          ],
        };
      }
      throw new SfError("The requested resource does not exist");
    }
    if (cmd === "api request rest") {
      expect(opts?.raw).toBe(true);
      if (args[3] === "/services/data/v62.0/sobjects/EventLogFile/0AT000000000001AAA/LogFile") return csv;
      if (args[3] === "/services/data/v62.0/sobjects/EventLogFile/0AT000000000003AAA/LogFile") return hourlyCsv;
      throw new Error(`unexpected log file ${args[3]}`);
    }
    if (cmd === "data query --query") {
      const soql = args[3]!;
      const records = (rows: unknown[]) => ({ records: rows.map((r) => ({ attributes: {}, ...(r as object) })) });
      if (soql.includes("FROM FlowInterview")) {
        expect(soql).toContain("InterviewStatus = 'Error'");
        return records([
          {
            FlowVersionViewId: "301000000000001AAA",
            CurrentElement: "Set_Default_Probability",
            InterviewLabel: "Opportunity: Set Defaults 10/3/2026, 9:00 AM",
            CreatedDate: "2026-10-03T09:00:00.000+0000",
            Error:
              "This error occurred: FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the contract signed date before closing the deal. Record Acme (006000000000001AAA) owner jane@acme.com",
          },
          {
            FlowVersionViewId: "301000000000009AAA",
            CurrentElement: "Update Related Contacts; DROP",
            InterviewLabel: "Account: Sync Tier To Contacts 10/4/2026",
            CreatedDate: "2026-10-04T09:00:00.000+0000",
            Error: "Something odd for Acme",
          },
        ]);
      }
      if (soql.includes("FROM Flow WHERE")) {
        expect(args).toContain("--use-tooling-api");
        if (overrides.noTooling) throw new SfError("sObject type 'Flow' is not supported");
        return records([{ Id: "301000000000001AAA", Definition: { DeveloperName: "Opportunity_Set_Defaults" } }]);
      }
      if (soql.includes("FROM EventLogFile")) {
        expect(soql).not.toMatch(/LIMIT 60\b/);
        if (soql.includes("Interval = 'Daily'")) {
          return records([
            {
              Id: "0AT000000000001AAA",
              LogDate: "2026-10-05T00:00:00.000+0000",
              LogFile: "/services/data/v62.0/sobjects/EventLogFile/0AT000000000001AAA/LogFile",
            },
          ]);
        }
        // Hourly files only after the last daily file, so nothing counts twice.
        expect(soql).toContain("Interval = 'Hourly' AND LogDate >= 2026-10-06T00:00:00Z");
        return records([
          {
            Id: "0AT000000000003AAA",
            LogDate: "2026-10-06T01:00:00.000+0000",
            LogFile: "/services/data/v62.0/sobjects/EventLogFile/0AT000000000003AAA/LogFile",
          },
        ]);
      }
      if (soql.includes("FROM ssot__AiAgentInteractionStep__dlm")) {
        expect(soql).toContain("ssot__ErrorMessageText__c <> null");
        expect(soql).not.toContain("!");
        return records([
          {
            ssot__Name__c: "Close_Opportunity",
            ssot__AiAgentInteractionStepType__c: "ACTION_STEP",
            ssot__ErrorMessageText__c:
              "FIELD_CUSTOM_VALIDATION_EXCEPTION, Enter the contract signed date before closing the deal.",
            ssot__StartTimestamp__c: "2026-10-05T11:00:00.000Z",
          },
          {
            ssot__Name__c: "Planner",
            ssot__AiAgentInteractionStepType__c: "LLM_STEP",
            ssot__ErrorMessageText__c: "Model timeout",
            ssot__StartTimestamp__c: "2026-10-05T11:00:00.000Z",
          },
          {
            ssot__Name__c: "Close Opportunity Now",
            ssot__AiAgentInteractionStepType__c: "ACTION_STEP",
            ssot__ErrorMessageText__c: "Something failed for Acme",
            ssot__StartTimestamp__c: "2026-10-05T11:30:00.000Z",
          },
        ]);
      }
      if (soql.includes("FROM AsyncApexJob")) {
        expect(soql).toContain("JobType IN ('Future', 'Queueable', 'BatchApex', 'ScheduledApex')");
        return records([
          {
            ApexClass: { Name: "OpportunityCloser", NamespacePrefix: null },
            JobType: "Queueable",
            ExtendedStatus:
              "First error: REQUIRED_FIELD_MISSING, Required fields are missing: [Contract_Signed_Date__c] for Acme",
            CreatedDate: "2026-10-04T10:00:00.000+0000",
            CompletedDate: "2026-10-04T10:01:00.000+0000",
          },
        ]);
      }
    }
    throw new Error(`unexpected sf call: ${args.join(" ")}`);
  }) as SfRunner;
  return { runner, calls };
}

describe("collecting errors from an org", () => {
  const since = new Date("2026-09-29T00:00:00Z");
  const until = new Date("2026-10-06T12:00:00Z");

  it("reads failed flows, Apex exceptions and failed jobs, keeping no record data", () => {
    const { runner } = fakeOrg();
    const r = collectIncidents({ model, vocab, since, until, org: "admin@acme.com", runner });
    expect(r.org).toBe("prod");
    expect(r.sources.map((s) => `${s.source}:${s.status}:${s.events}`)).toEqual([
      "flow:ok:2",
      "apex:ok:3",
      "async-apex:ok:1",
      "agent:unavailable:0",
    ]);
    // The event log covers less than the window, and says so.
    const apex = r.sources.find((s) => s.source === "apex")!;
    expect(apex.coverage).toEqual({ from: "2026-10-05T00:00:00.000Z", to: "2026-10-06T02:00:00.000Z" });
    expect(apex.note).toContain("the event log covers errors up to 2026-10-06 02:00 UTC");
    expect(apex.note).toContain("the event log starts 2026-10-05 00:00 UTC");
    expect(r.sources.find((s) => s.source === "agent")?.note).toBe("needs Agentforce session tracing in Data 360");
    const byWhere = Object.fromEntries(r.incidents.map((i) => [`${i.source}:${i.component.name}`, i]));
    expect(byWhere["flow:Opportunity_Set_Defaults"]).toMatchObject({
      component: { kind: "Flow", name: "Opportunity_Set_Defaults", element: "Set_Default_Probability" },
      signature: { category: "validation", validationRules: ["Opportunity.Require_Contract_Signed_Date"] },
      count: 1,
    });
    // The Tooling API doesn't know this flow version: it isn't guessed from the interview label,
    // and the odd element is dropped.
    expect(byWhere["flow:(unknown flow)"]?.component).toEqual({ kind: "Flow", name: "(unknown flow)" });
    // The daily file for Oct 5 and the hourly file after it.
    expect(byWhere["apex:ContactTriggerHandler"]).toMatchObject({
      signature: { category: "soql-limit" },
      via: [{ kind: "ApexTrigger", name: "ContactTrigger" }],
      firstSeen: "2026-10-06T01:15:00.000Z",
    });
    expect(byWhere["apex:OpportunityCloser"]).toMatchObject({
      signature: { category: "null-pointer", exceptionType: "System.NullPointerException" },
      count: 2,
      firstSeen: "2026-10-05T09:30:00.000Z",
      lastSeen: "2026-10-05T10:30:00.000Z",
    });
    expect(byWhere["async-apex:OpportunityCloser"]).toMatchObject({
      signature: { category: "required-field", fields: ["Opportunity.Contract_Signed_Date__c"] },
    });
    expect(JSON.stringify(r)).not.toMatch(LEAKS);
  });

  it("reads failed Agentforce action steps only", () => {
    const r = collectIncidents({
      model,
      vocab,
      since,
      until,
      org: "prod",
      runner: fakeOrg({ agent: true }).runner,
      sources: ["agent"],
    });
    expect(r.sources[0]).toMatchObject({
      status: "ok",
      events: 1,
      note: "1 failed step without an action API name skipped",
    });
    expect(r.incidents[0]).toMatchObject({
      component: { kind: "AgentAction", name: "Close_Opportunity" },
      signature: { validationRules: ["Opportunity.Require_Contract_Signed_Date"] },
    });
    expect(JSON.stringify(r)).not.toMatch(LEAKS);
  });

  it("says when a source isn't available, and matches flows by label without the Tooling API", () => {
    const { runner } = fakeOrg({ noFailedInterviews: true });
    const r = collectIncidents({ model, vocab, since, until, org: "prod", runner, sources: ["flow"] });
    expect(r.sources).toEqual([
      {
        source: "flow",
        label: "Failed flow interviews",
        status: "unavailable",
        events: 0,
        note: "this org doesn't keep failed flow interviews",
      },
    ]);
    const noTooling = collectIncidents({
      model,
      vocab,
      since,
      until,
      org: "prod",
      runner: fakeOrg({ noTooling: true }).runner,
      sources: ["flow"],
    });
    expect(noTooling.incidents.map((i) => i.component.name).sort()).toEqual([
      "Account_Sync_Tier_To_Contacts",
      "Opportunity_Set_Defaults",
    ]);
  });

  it("imports errors from a file", () => {
    const { events, skipped } = importErrors(
      [
        {
          component: "AgentAction:Close_Opportunity",
          message: "FIELD_CUSTOM_VALIDATION_EXCEPTION, Enter the contract signed date before closing the deal.",
          count: 3,
          at: "2026-10-03T00:00:00Z",
        },
        {
          component: { kind: "Flow", name: "Opportunity_Set_Defaults", element: "Set_Default_Probability" },
          firstSeen: "2026-10-01T00:00:00Z",
          lastSeen: "2026-10-02T00:00:00Z",
        },
        { component: "Nope:Thing", at: "2026-10-03T00:00:00Z" },
        { component: "Flow:Bad Name!", at: "2026-10-03T00:00:00Z" },
        { component: "Flow:No_Time" },
      ],
      vocab,
    );
    expect(skipped).toBe(3);
    expect(events.map((e) => [e.component.name, e.count, e.signature.validationRules])).toEqual([
      ["Close_Opportunity", 3, ["Opportunity.Require_Contract_Signed_Date"]],
      ["Opportunity_Set_Defaults", 1, []],
    ]);
    expect(() => importErrors({ nope: 1 }, vocab)).toThrow("expected a JSON list");
    expect(groupIncidents([...events, ...events]).map((i) => i.count)).toEqual([6, 2]);
  });
});

describe("tracing errors to changes and rolling back", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      stdio: "pipe",
    }).toString();
  const gitAt = (date: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      stdio: "pipe",
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    });
  const commitAt = (date: string, ...args: string[]) => gitAt(date, "commit", "-q", ...args);
  const at = (rel: string) => path.join(repo, SRC, rel);
  const errors = [
    {
      component: { kind: "AgentAction", name: "Close_Opportunity" },
      message: "FIELD_CUSTOM_VALIDATION_EXCEPTION, Enter a close reason before closing the deal.: [Description] Acme",
      count: 5,
      firstSeen: "2026-10-03T08:00:00Z",
      lastSeen: "2026-10-05T09:00:00Z",
    },
    {
      component: "ApexClass:ContactTriggerHandler",
      message: "System.LimitException: Too many SOQL queries: 101",
      at: "2026-10-05T12:00:00Z",
    },
    {
      component: "Flow:Update_Customer_Tier",
      message: "Attempt to de-reference a null object",
      count: 2,
      firstSeen: "2026-09-30T08:00:00Z",
      lastSeen: "2026-10-05T08:00:00Z",
    },
  ];

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-incidents-"));
    cpSync(FIXTURE, repo, { recursive: true });
    git("init", "-q", "-b", "main");
    git("add", ".");
    commitAt("2026-09-20T10:00:00Z", "-m", "base");
    // #12 (squash merge): a new validation rule on Opportunity.
    writeFileSync(
      at("objects/Opportunity/validationRules/Require_Close_Reason.validationRule-meta.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Require_Close_Reason</fullName>
    <active>true</active>
    <errorConditionFormula>AND(IsClosed, ISBLANK(Description))</errorConditionFormula>
    <errorMessage>Enter a close reason before closing the deal.</errorMessage>
</ValidationRule>`,
    );
    git("add", ".");
    commitAt("2026-10-02T10:00:00Z", "-m", "Add close reason rule (#12)");
    // #13 (merge commit): a change to the contact trigger handler.
    git("checkout", "-q", "-b", "handler");
    writeFileSync(
      at("classes/ContactTriggerHandler.cls"),
      `${readFileSync(at("classes/ContactTriggerHandler.cls"), "utf8")}// tuned\n`,
    );
    git("add", ".");
    commitAt("2026-10-04T09:00:00Z", "-m", "Tune handler");
    git("checkout", "-q", "main");
    gitAt(
      "2026-10-04T10:00:00Z",
      "merge",
      "-q",
      "--no-ff",
      "handler",
      "-m",
      "Merge pull request #13 from team/handler",
      "-m",
      "Speed up the contact handler",
    );
    // #14, after the errors: drops a field, adds a subflow and a class.
    unlinkSync(at("objects/Account/fields/Last_Contact_Change__c.field-meta.xml"));
    const handler = readFileSync(at("classes/ContactTriggerHandler.cls"), "utf8");
    writeFileSync(
      at("classes/ContactTriggerHandler.cls"),
      handler
        .replace("SELECT Id, Last_Contact_Change__c FROM Account", "SELECT Id FROM Account")
        .replace("parent.Last_Contact_Change__c = System.now();", ""),
    );
    writeFileSync(
      at("flows/Close_Followup.flow-meta.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>Close Followup</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`,
    );
    const parent = readFileSync(at("flows/Opportunity_Closed_Won_Followup.flow-meta.xml"), "utf8");
    writeFileSync(
      at("flows/Opportunity_Closed_Won_Followup.flow-meta.xml"),
      parent.replace(
        "</Flow>",
        "    <subflows>\n        <name>Run_Followup</name>\n        <label>Run Followup</label>\n        <locationX>0</locationX>\n        <locationY>0</locationY>\n        <flowName>Close_Followup</flowName>\n    </subflows>\n</Flow>",
      ),
    );
    writeFileSync(
      at("classes/FollowupService.cls"),
      "public with sharing class FollowupService {\n    public static void schedule(Id oppId) {}\n}\n",
    );
    writeFileSync(
      at("classes/FollowupService.cls-meta.xml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
    );
    const closer = readFileSync(at("classes/OpportunityCloser.cls"), "utf8");
    writeFileSync(
      at("classes/OpportunityCloser.cls"),
      closer.replace(/\}\s*$/, "    static void later(Id id) { FollowupService.schedule(id); }\n}\n"),
    );
    mkdirSync(at("objects/Opportunity/fields"), { recursive: true });
    writeFileSync(
      at("objects/Opportunity/fields/Close_Notes__c.field-meta.xml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Close_Notes__c</fullName><label>Close Notes</label><type>LongTextArea</type><length>32768</length><visibleLines>3</visibleLines></CustomField>\n',
    );
    git("add", "-A");
    commitAt("2026-10-06T12:00:00Z", "-m", "Rework follow-ups (#14)");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("lists recent changes with their pull requests", () => {
    const h = recentChanges(repo, { since: new Date("2026-09-01T00:00:00Z") });
    expect(h.changes.map((c) => [c.shortSha.length, c.pr, c.subject])).toEqual([
      [7, 14, "Rework follow-ups"],
      [7, 13, "Speed up the contact handler"],
      [7, 12, "Add close reason rule"],
    ]);
    expect(h.shallow).toBe(false);
  });

  it("points each error at the change most likely to have caused it", () => {
    const r = investigateIncidents({
      projectDir: repo,
      since: new Date("2026-09-28T00:00:00Z"),
      errors: { raw: errors, file: "e.json" },
    });
    const [rule, handler, unrelated] = [
      r.incidents.find((i) => i.component.name === "Close_Opportunity")!,
      r.incidents.find((i) => i.component.name === "ContactTriggerHandler")!,
      r.incidents.find((i) => i.component.name === "Update_Customer_Tier")!,
    ];
    expect(rule.signature.validationRules).toEqual(["Opportunity.Require_Close_Reason"]);
    expect(rule.suspects[0]).toMatchObject({
      change: { pr: 12, subject: "Add close reason rule" },
      confidence: "high",
      components: [{ type: "ValidationRule", name: "Opportunity.Require_Close_Reason", changeType: "added" }],
    });
    expect(rule.suspects[0]!.reasons).toContain(
      "It added validation rule `Opportunity.Require_Close_Reason`, and the error is that rule's message.",
    );
    expect(rule.suspects[0]!.reasons).toContain("The errors started 22 hours after it was merged.");
    expect(handler.suspects[0]).toMatchObject({ change: { pr: 13 }, confidence: "high" });
    expect(handler.suspects[0]!.reasons[0]).toBe(
      "It changed Apex class `ContactTriggerHandler`, where the error happens.",
    );
    // #14 was merged after the last error, so it's never a suspect.
    expect(r.incidents.flatMap((i) => i.suspects).some((s) => s.change.pr === 14)).toBe(false);
    expect(unrelated.suspects.every((s) => s.confidence !== "high")).toBe(true);
    const md = incidentsToMarkdown(r);
    expect(md).toContain("**3 problems, 2 traced to recent changes.**");
    expect(md).toContain("`preflight rollback");
    expect(md).toContain("--component Opportunity.Require_Close_Reason`");
    expect(md).not.toMatch(LEAKS);
  });

  it("uses when components changed in the org to judge timing", () => {
    const history = recentChanges(repo, { since: new Date("2026-09-01T00:00:00Z") });
    const collection = collectIncidents({
      model: loadProject(repo),
      vocab: mergeVocabulary(vocabularyFromModel(loadProject(repo)), {
        validationRules: [
          { name: "Opportunity.Require_Close_Reason", message: "Enter a close reason before closing the deal." },
        ],
      }),
      since: new Date("2026-09-28T00:00:00Z"),
      imported: { raw: [errors[0]], file: "e.json" },
    });
    const trace = (date: string) =>
      traceIncidents({
        model: loadProject(repo),
        collection,
        history,
        projectDir: repo,
        orgDates: new Map([["validationrule:opportunity.require_close_reason", date]]),
      }).incidents[0]!.suspects[0]!;
    expect(trace("2026-10-03T06:00:00.000Z").reasons).toContain(
      "The errors started 2 hours after validation rule `Opportunity.Require_Close_Reason` changed in the org (2026-10-03).",
    );
    const stale = trace("2026-09-01T00:00:00.000Z");
    expect(stale.reasons.at(-1)).toContain("before this change, so it may not be deployed there");
    expect(stale.confidence).not.toBe("high");
  });

  it("doesn't date errors that were already there when the data starts", () => {
    const history = recentChanges(repo, { since: new Date("2026-09-01T00:00:00Z") });
    const m = loadProject(repo);
    // Errors every half hour from ten minutes into the window: they were likely there before it.
    const collection = collectIncidents({
      model: m,
      vocab: vocabularyFromModel(m),
      since: new Date("2026-10-04T10:30:00Z"),
      until: new Date("2026-10-06T00:00:00Z"),
      imported: {
        raw: [
          {
            component: "ApexClass:ContactTriggerHandler",
            message: "System.LimitException: Too many SOQL queries: 101",
            count: 50,
            firstSeen: "2026-10-04T10:40:00Z",
            lastSeen: "2026-10-05T11:10:00Z",
          },
        ],
        file: "e.json",
      },
    });
    const suspect = traceIncidents({ model: m, collection, history, projectDir: repo }).incidents[0]!.suspects[0]!;
    expect(suspect.change.pr).toBe(13);
    expect(suspect.reasons).toContain(
      "The errors show up from the start of the data read (2026-10-04), so when they began isn't known.",
    );
    expect(suspect.reasons.some((r) => r.startsWith("The errors started"))).toBe(false);
    // The direct hit and the matching finding count; no bonus for a start time it can't know.
    expect(suspect.score).toBe(75);
  });

  it("keeps GitHub user and branch names out of commit subjects", () => {
    expect(cleanSubject("Merge pull request #13 from team/handler")).toBe("Merge pull request #13");
    expect(cleanSubject("Merge branch 'jdoe/fix' into main")).toBe("Merge branch");
    expect(cleanSubject("Fix it for jane@acme.com (#4)")).toBe("Fix it for <username> (#4)");
  });

  it("deactivates a rule the change added", () => {
    const plan = planRollback({ projectDir: repo, model: loadProject(repo), change: changeAt(repo, "HEAD~2") });
    expect(plan.steps).toEqual([
      {
        component: expect.objectContaining({ name: "Opportunity.Require_Close_Reason", changeType: "added" }),
        action: "deactivate",
        how: "Set `active` to false.",
        restore: [],
        remove: [],
        edits: [
          {
            file: `${SRC}/objects/Opportunity/validationRules/Require_Close_Reason.validationRule-meta.xml`,
            from: "<active>true</active>",
            to: "<active>false</active>",
          },
        ],
      },
    ]);
    expect(plan.commands[1]).toBe(`preflight rollback ${plan.change.shortSha} --restore`);
  });

  it("restores changed code and warns about later commits to the same files", () => {
    const plan = planRollback({
      projectDir: repo,
      model: loadProject(repo),
      change: changeAt(repo, "HEAD~1"),
      org: "prod",
    });
    expect(plan.change).toMatchObject({ pr: 13, subject: "Speed up the contact handler" });
    // The class and its -meta.xml, from the tree before the change.
    expect(plan.steps.map((s) => [s.component.name, s.action, s.restore])).toEqual([
      [
        "ContactTriggerHandler",
        "restore",
        [`${SRC}/classes/ContactTriggerHandler.cls`, `${SRC}/classes/ContactTriggerHandler.cls-meta.xml`],
      ],
    ]);
    expect(plan.warnings[0]).toContain("Later commits also changed the files being restored");
    expect(plan.warnings[0]).toContain("Rework follow-ups (#14)");
    expect(plan.apex).toBe(true);
    expect(plan.commands).toContain(
      `sf project deploy validate --target-org prod --test-level RunLocalTests --source-dir ${SRC}/classes/ContactTriggerHandler.cls --source-dir ${SRC}/classes/ContactTriggerHandler.cls-meta.xml`,
    );
    expect(rollbackToMarkdown(plan)).toContain("The rollback includes Apex");
  });

  it("brings along what keeps a partial rollback consistent", () => {
    const m = loadProject(repo);
    const change = changeAt(repo, "HEAD");
    // The handler's previous version uses the field the change deleted.
    const handler = planRollback({ projectDir: repo, model: m, change, components: ["ContactTriggerHandler"] });
    expect(handler.steps.map((s) => [s.component.name, s.action, s.because ?? ""])).toEqual([
      ["ContactTriggerHandler", "restore", ""],
      [
        "Account.Last_Contact_Change__c",
        "restore",
        "the previous version of Apex class `ContactTriggerHandler` uses field `Account.Last_Contact_Change__c`, which the change deleted",
      ],
    ]);
    // A deleted field comes back by undeleting it (with its data), not by deploying an empty one.
    expect(handler.steps[1]!.how).toContain("undelete it there");
    expect(handler.warnings).toContain(
      "Undelete field `Account.Last_Contact_Change__c` in Setup before deploying the rollback; the deployment leaves it out.",
    );
    expect(handler.deploy.some((f) => f.includes("Last_Contact_Change__c"))).toBe(false);
    expect(handler.deploy).toContain(`${SRC}/classes/ContactTriggerHandler.cls`);
    // Deactivating the new subflow means restoring the flow that now calls it.
    const flow = planRollback({ projectDir: repo, model: m, change, components: ["Flow:Close_Followup"] });
    expect(flow.steps.map((s) => [s.component.name, s.action])).toEqual([
      ["Close_Followup", "deactivate"],
      ["Opportunity_Closed_Won_Followup", "restore"],
    ]);
    // A deployed flow's own status can't deactivate it; a FlowDefinition with no active version can.
    expect(flow.steps[0]!.edits).toEqual([
      {
        file: `${SRC}/flowDefinitions/Close_Followup.flowDefinition-meta.xml`,
        to: expect.stringContaining("<activeVersionNumber>0</activeVersionNumber>"),
      },
    ]);
    expect(flow.steps[1]!.how).toContain("activate it in Setup → Flows");
    expect(flow.commands[1]).toBe(`preflight rollback ${change.shortSha} --component Flow:Close_Followup --restore`);
    // A new class that something calls stays; its callers go back instead. New fields stay.
    const cls = planRollback({
      projectDir: repo,
      model: m,
      change,
      components: ["FollowupService", "Opportunity.Close_Notes__c"],
    });
    expect(cls.steps.map((s) => [s.component.name, s.action])).toEqual([
      ["FollowupService", "keep"],
      ["Opportunity.Close_Notes__c", "keep"],
      ["OpportunityCloser", "restore"],
    ]);
    expect(cls.steps[0]!.how).toBe("`OpportunityCloser` uses it; roll back what calls it instead.");
    expect(() => planRollback({ projectDir: repo, model: m, change, components: ["Nope"] })).toThrow(
      "didn't change Nope",
    );
  });

  it("applies a plan to the working tree, but never over uncommitted work", () => {
    const m = loadProject(repo);
    const change = changeAt(repo, "HEAD");
    const plan = planRollback({ projectDir: repo, model: m, change, components: ["Close_Followup"] });
    const parentFlow = at("flows/Opportunity_Closed_Won_Followup.flow-meta.xml");
    writeFileSync(parentFlow, `${readFileSync(parentFlow, "utf8")}<!-- local edit -->\n`);
    expect(() => applyRollback(repo, plan)).toThrow("uncommitted changes");
    git("checkout", "-q", "--", ".");
    const definition = `${SRC}/flowDefinitions/Close_Followup.flowDefinition-meta.xml`;
    expect(applyRollback(repo, plan)).toEqual({
      restored: [`${SRC}/flows/Opportunity_Closed_Won_Followup.flow-meta.xml`],
      removed: [],
      edited: [],
      created: [definition],
      skipped: [],
    });
    expect(readFileSync(parentFlow, "utf8")).not.toContain("Close_Followup");
    expect(readFileSync(path.join(repo, definition), "utf8")).toContain("<activeVersionNumber>0</activeVersionNumber>");
    // Nothing is staged: `git diff` shows the rollback.
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("diff", "--name-only")).toContain("Opportunity_Closed_Won_Followup.flow-meta.xml");
    git("checkout", "-q", "--", ".");
    rmSync(path.join(repo, SRC, "flowDefinitions"), { recursive: true, force: true });
  });
});

describe("rolling back renames, companion files and added files", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      stdio: "pipe",
    }).toString();
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const at = (rel: string) => path.join(repo, SRC, rel);
  const shas: Record<string, string> = {};

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-rollback-"));
    cpSync(FIXTURE, repo, { recursive: true });
    git("init", "-q", "-b", "main");
    commit("base");
    // A class renamed with heavy edits: git pairs only the identical -meta.xml files as a rename.
    unlinkSync(at("classes/ContactTriggerHandler.cls"));
    git("mv", `${SRC}/classes/ContactTriggerHandler.cls-meta.xml`, `${SRC}/classes/ContactUpdatesHandler.cls-meta.xml`);
    writeFileSync(
      at("classes/ContactUpdatesHandler.cls"),
      "public with sharing class ContactUpdatesHandler {\n    public static void handle(List<Contact> rows) {\n        System.debug(rows.size());\n    }\n}\n",
    );
    writeFileSync(
      at("triggers/ContactTrigger.trigger"),
      readFileSync(at("triggers/ContactTrigger.trigger"), "utf8").replace(
        /ContactTriggerHandler/g,
        "ContactUpdatesHandler",
      ),
    );
    shas.classRename = commit("Rename the handler (#20)");
    // A trigger renamed as is.
    git("mv", `${SRC}/triggers/ContactTrigger.trigger`, `${SRC}/triggers/ContactUpdates.trigger`);
    git("mv", `${SRC}/triggers/ContactTrigger.trigger-meta.xml`, `${SRC}/triggers/ContactUpdates.trigger-meta.xml`);
    shas.triggerRename = commit("Rename the trigger (#21)");
    // A bot change that adds a version.
    const bot = at("bots/Sales_Agent/Sales_Agent.bot-meta.xml");
    writeFileSync(bot, readFileSync(bot, "utf8").replace("</Bot>", "    <!-- v2 -->\n</Bot>"));
    writeFileSync(
      at("bots/Sales_Agent/v2.botVersion-meta.xml"),
      readFileSync(at("bots/Sales_Agent/v1.botVersion-meta.xml")),
    );
    shas.botVersion = commit("Add agent version 2 (#22)");
    // A new flow, then (separately) code that runs it.
    writeFileSync(
      at("flows/Notify_Owner.flow-meta.xml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <label>Notify Owner</label>\n    <processType>AutoLaunchedFlow</processType>\n    <status>Active</status>\n</Flow>\n',
    );
    shas.newFlow = commit("Add owner notification (#23)");
    writeFileSync(
      at("classes/Notifier.cls"),
      "public with sharing class Notifier {\n    public static void run() {\n        Flow.Interview.Notify_Owner f = new Flow.Interview.Notify_Owner(new Map<String, Object>());\n        f.start();\n    }\n}\n",
    );
    writeFileSync(at("classes/Notifier.cls-meta.xml"), readFileSync(at("classes/OpportunityCloser.cls-meta.xml")));
    commit("Notify from Apex (#24)");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const reset = () => {
    git("checkout", "-q", "--", ".");
    git("clean", "-fdq");
  };

  it("restores a class with its -meta.xml when git pairs only the -meta.xml as a rename", () => {
    const change = changeAt(repo, shas.classRename!);
    const m = loadProject(repo);
    const old = planRollback({ projectDir: repo, model: m, change, components: ["ContactTriggerHandler"] });
    expect(old.steps[0]).toMatchObject({
      component: { name: "ContactTriggerHandler", changeType: "deleted" },
      action: "restore",
      restore: [`${SRC}/classes/ContactTriggerHandler.cls`, `${SRC}/classes/ContactTriggerHandler.cls-meta.xml`],
    });
    // Rolling back the new class (git sees it as added): it stays because the trigger calls it,
    // the trigger goes back, and with it the old class it used, -meta.xml included.
    const renamed = planRollback({ projectDir: repo, model: m, change, components: ["ContactUpdatesHandler"] });
    expect(renamed.steps.map((s) => [s.component.name, s.action, s.because ?? ""])).toEqual([
      ["ContactUpdatesHandler", "keep", ""],
      ["ContactTrigger", "restore", "it calls Apex class `ContactUpdatesHandler`, which the change added"],
      [
        "ContactTriggerHandler",
        "restore",
        "the previous version of trigger `ContactTrigger` uses Apex class `ContactTriggerHandler`, which the change deleted",
      ],
    ]);
    expect(renamed.steps[2]!.restore).toEqual([
      `${SRC}/classes/ContactTriggerHandler.cls`,
      `${SRC}/classes/ContactTriggerHandler.cls-meta.xml`,
    ]);
  });

  it("deactivates a renamed trigger's new name, so the two don't both run", () => {
    const change = changeAt(repo, shas.triggerRename!);
    const plan = planRollback({ projectDir: repo, model: loadProject(repo), change });
    expect(plan.steps.map((s) => [s.component.name, s.action])).toEqual([
      ["ContactTrigger", "restore"],
      ["ContactUpdates", "deactivate"],
    ]);
    expect(plan.steps[0]!.restore).toEqual([
      `${SRC}/triggers/ContactTrigger.trigger`,
      `${SRC}/triggers/ContactTrigger.trigger-meta.xml`,
    ]);
    expect(plan.steps[1]!.edits).toEqual([
      {
        file: `${SRC}/triggers/ContactUpdates.trigger-meta.xml`,
        from: "<status>Active</status>",
        to: "<status>Inactive</status>",
      },
    ]);
    expect(plan.deploy).toEqual([
      `${SRC}/triggers/ContactTrigger.trigger`,
      `${SRC}/triggers/ContactTrigger.trigger-meta.xml`,
      `${SRC}/triggers/ContactUpdates.trigger-meta.xml`,
    ]);
    const applied = applyRollback(repo, plan);
    expect(applied).toMatchObject({ edited: [`${SRC}/triggers/ContactUpdates.trigger-meta.xml`], skipped: [] });
    expect(readFileSync(at("triggers/ContactTrigger.trigger"), "utf8")).toContain("trigger ContactTrigger");
    expect(readFileSync(at("triggers/ContactUpdates.trigger-meta.xml"), "utf8")).toContain("<status>Inactive</status>");
    reset();
  });

  it("removes files the change added to a component it restores", () => {
    const change = changeAt(repo, shas.botVersion!);
    const plan = planRollback({ projectDir: repo, model: loadProject(repo), change });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      component: { type: "AgentMetadata", name: "Sales_Agent" },
      restore: [`${SRC}/bots/Sales_Agent/Sales_Agent.bot-meta.xml`, `${SRC}/bots/Sales_Agent/v1.botVersion-meta.xml`],
      remove: [`${SRC}/bots/Sales_Agent/v2.botVersion-meta.xml`],
    });
    expect(plan.warnings.join("\n")).toContain("doesn't remove it from the org");
    const applied = applyRollback(repo, plan);
    expect(applied.removed).toEqual([`${SRC}/bots/Sales_Agent/v2.botVersion-meta.xml`]);
    expect(() => readFileSync(at("bots/Sales_Agent/v2.botVersion-meta.xml"))).toThrow();
    reset();
  });

  it("warns when code outside the change runs a flow the rollback deactivates", () => {
    const plan = planRollback({ projectDir: repo, model: loadProject(repo), change: changeAt(repo, shas.newFlow!) });
    expect(plan.steps.map((s) => [s.component.name, s.action])).toEqual([["Notify_Owner", "deactivate"]]);
    expect(plan.warnings).toContain(
      "Apex class `Notifier` runs flow `Notify_Owner` and isn't part of this change: deactivating it makes that fail. Roll it back too, or keep the flow.",
    );
  });

  it("skips an edit that no longer applies", () => {
    const plan = planRollback({
      projectDir: repo,
      model: loadProject(repo),
      change: changeAt(repo, shas.triggerRename!),
    });
    const meta = at("triggers/ContactUpdates.trigger-meta.xml");
    writeFileSync(meta, readFileSync(meta, "utf8").replace("<status>Active</status>", "<status>Inactive</status>"));
    commit("Turn the trigger off");
    expect(applyRollback(repo, plan).skipped).toEqual([`${SRC}/triggers/ContactUpdates.trigger-meta.xml`]);
    reset();
    git("reset", "-q", "--hard", "HEAD~1");
  });
});

describe.skipIf(process.platform === "win32")("the sf runner's raw output", () => {
  it("returns standard output as text without --json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-sf-"));
    writeFileSync(path.join(dir, "sf"), '#!/bin/sh\necho "args:$*"\n');
    chmodSync(path.join(dir, "sf"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${before}`;
    try {
      expect(createSfRunner()(["api", "request", "rest", "/x"], { raw: true })).toBe("args:api request rest /x\n");
    } finally {
      process.env.PATH = before;
    }
  });

  it("keeps the command line and record IDs out of errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preflight-sf-"));
    writeFileSync(
      path.join(dir, "sf"),
      '#!/bin/sh\necho "Error: GET /services/data/v62.0/sobjects/EventLogFile/0AT000000000001AAA/LogFile returned NOT_FOUND for 0AT000000000001AAA" >&2\nexit 1\n',
    );
    chmodSync(path.join(dir, "sf"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${before}`;
    try {
      const url = "/services/data/v62.0/sobjects/EventLogFile/0AT000000000001AAA/LogFile";
      expect(() => createSfRunner()(["api", "request", "rest", url], { raw: true })).toThrow(
        "sf api request rest failed: Error: GET <url> returned NOT_FOUND for <id>",
      );
    } finally {
      process.env.PATH = before;
    }
  });
});
