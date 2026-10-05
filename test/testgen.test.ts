import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApexErrorListener,
  ApexParserFactory,
  CatchClauseContext,
  ClassDeclarationContext,
  EnhancedForControlContext,
  FormalParameterContext,
  MethodDeclarationContext,
  PropertyDeclarationContext,
  VariableDeclaratorContext,
} from "@apexdevtools/apex-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyze,
  generateTests,
  loadProject,
  type OrgModel,
  runTests,
  testsToMarkdown,
  toChanges,
} from "../src/core/index.js";
import { analyzeApexAst } from "../src/core/parsers/apexAst.js";
import { parseFlow } from "../src/core/parsers/flows.js";
import { apexString } from "../src/core/testgen/generate.js";
import { solverContext } from "../src/core/testgen/schema.js";
import {
  assign,
  emptyAssignment,
  evaluate,
  type FValue,
  parseFormula,
  type SolverContext,
  solveRules,
} from "../src/core/testgen/solver.js";
import { createMcpServer } from "../src/mcp.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const FIELD = `${SRC}/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml`;

let model: OrgModel;
beforeAll(() => {
  model = loadProject(FIXTURE);
});

const gen = (file: string, m = model) => {
  const { changes } = toChanges([{ file, changeType: "modified" }]);
  return generateTests(m, analyze({ model: m, changes }));
};
const fileOf = (g: ReturnType<typeof gen>, suffix: string) => g.files.find((f) => f.path.endsWith(suffix))!.content;
const methodOf = (src: string, name: string) => {
  const start = src.indexOf(`static void ${name}()`);
  return src.slice(start, src.indexOf("\n    }", start));
};

/** A context where every simple field is settable and blank unless set. */
const ctx = (event: "insert" | "update" = "insert", defaults: Record<string, FValue> = {}): SolverContext => ({
  event,
  settable: (f) => !f.includes(".") && !f.startsWith("$"),
  defaultOf: (f) => defaults[f.toLowerCase()] ?? { kind: "null" },
});
const values = (a: ReturnType<typeof emptyAssignment>) =>
  Object.fromEntries([...a.values].map(([k, v]) => [a.names.get(k), v]));

describe("formula parser", () => {
  it("parses functions, operators, strings, comments and precedence", () => {
    const e = parseFormula(`/* finance */ AND(ISPICKVAL(StageName, "Closed Won"), Amount__c >= 100 || NOT(IsPrivate))`);
    expect(e).toMatchObject({ t: "call", name: "AND" });
    const [, second] = (e as { args: unknown[] }).args as [unknown, { t: string; op: string }];
    expect(second).toMatchObject({ t: "bin", op: "||" });
    expect(parseFormula("'it\\'s' & Name")).toMatchObject({ t: "bin", op: "&" });
    expect(() => parseFormula("AND(")).toThrow();
  });
});

describe("validation-rule solver", () => {
  const rule = { name: "Require_Contract", formula: 'AND(ISPICKVAL(StageName, "Closed Won"), ISBLANK(Contract__c))' };

  it("falsifies an AND rule using the first free condition", () => {
    // StageName is required, so the factory always fills it: the rule could fire.
    const r = solveRules([rule], ctx("insert", { stagename: { kind: "any" } }), emptyAssignment());
    expect(r.unsolved).toEqual([]);
    expect(values(r.assignment)).toEqual({ StageName: { kind: "not", value: "Closed Won" } });
  });

  it("works around fields the test fixes", () => {
    const intent = assign(emptyAssignment(), "StageName", { kind: "lit", value: "Closed Won" });
    const r = solveRules([rule], ctx(), intent);
    expect(values(r.assignment)).toEqual({
      StageName: { kind: "lit", value: "Closed Won" },
      Contract__c: { kind: "any" },
    });
  });

  it("handles OR, NOT, IF, comparisons and literals on either side", () => {
    const rules = [
      { name: "a", formula: "OR(ISBLANK(Region__c), 5 < Score__c)" },
      { name: "b", formula: "NOT(Active__c)" },
      { name: "c", formula: 'IF(ISPICKVAL(Type, "Partner"), ISBLANK(Partner_Id__c), FALSE)' },
      { name: "d", formula: "Discount__c <> 0" },
    ];
    const r = solveRules(rules, ctx(), emptyAssignment());
    expect(r.unsolved).toEqual([]);
    expect(values(r.assignment)).toMatchObject({
      Region__c: { kind: "any" },
      Score__c: { kind: "lit", value: 5 },
      Active__c: { kind: "lit", value: true },
      Discount__c: { kind: "lit", value: 0 },
    });
  });

  it("knows ISNEW and ISCHANGED on insert", () => {
    const r = solveRules([{ name: "x", formula: "AND(ISNEW(), ISCHANGED(Name))" }], ctx("insert"), emptyAssignment());
    expect(r.unsolved).toEqual([]);
    const e = parseFormula("ISNEW()");
    expect(evaluate(e, emptyAssignment(), ctx("update"))).toBe(false);
  });

  it("reports rules it can't control and rules the test's own values violate", () => {
    const intent = assign(emptyAssignment(), "Contract__c", { kind: "null" });
    const r = solveRules(
      [
        { name: "profile", formula: "$Profile.Name <> 'System Administrator'" },
        { name: "needs_contract", formula: "ISBLANK(Contract__c)" },
        { name: "broken", formula: "AND(" },
      ],
      ctx(),
      intent,
    );
    expect(r.unsolved.map((u) => `${u.name}: ${u.reason}`)).toEqual([
      "profile: uses functions or fields the generator can't control",
      "needs_contract: the values this test needs violate it",
      "broken: formula not understood (Unexpected end of formula)",
    ]);
  });

  it("uses project metadata for defaults and settable fields", () => {
    const c = solverContext(model, "Opportunity", "insert");
    expect(c.defaultOf("Contract_Signed_Date__c")).toEqual({ kind: "null" });
    expect(c.defaultOf("StageName")).toEqual({ kind: "any" });
    expect(c.settable("IsWon")).toBe(false);
    expect(solverContext(model, "Account", "insert").settable("Total_Won_Amount__c")).toBe(false);
  });
});

describe("flow parsing for test generation", () => {
  it("captures entry filters with values and link fields to the triggering record", () => {
    const read = (f: string) => readFileSync(path.join(FIXTURE, SRC, "flows", f), "utf8");
    const followup = parseFlow(read("Opportunity_Closed_Won_Followup.flow-meta.xml"), "x", "f");
    expect(followup.trigger?.filters).toEqual([
      { field: "StageName", operator: "EqualTo", value: { kind: "string", value: "Closed Won" } },
    ]);
    expect(followup.writes.find((w) => w.object === "Task")?.linkField).toBe("WhatId");
    const sync = parseFlow(read("Account_Sync_Tier_To_Contacts.flow-meta.xml"), "y", "f");
    expect(sync.writes.find((w) => w.object === "Contact")?.linkField).toBe("AccountId");
    expect(sync.trigger?.filters[0]).toMatchObject({ field: "Customer_Tier__c", operator: "IsChanged" });
  });
});

describe("test generation", () => {
  it("generates bulk, recursion, idempotency and validation-error tests for a field change", () => {
    const g = gen(FIELD);
    expect(g.tests.map((t) => `${t.kind}:${t.method}`)).toEqual([
      "bulk:bulkUpdateOpportunity",
      "bulk:bulkInsertOpportunity",
      "recursion:recursionAccountContact",
      "idempotency:idempotentOpportunityClosedWonFollowup",
      "validation-collision:surfacesErrorsOpportunityCloserRequireContractSignedDate",
    ]);
    expect(g.skipped.map((s) => `${s.kind}: ${s.reason}`)).toEqual([
      "recursion: Covered by the bulk update test of Opportunity, which meets flow Opportunity_Closed_Won_Followup's entry criteria.",
    ]);
    expect(g.files.map((f) => f.path)).toEqual([
      "classes/PreflightDataFactory.cls",
      "classes/PreflightDataFactory.cls-meta.xml",
      "classes/PreflightChangeTest.cls",
      "classes/PreflightChangeTest.cls-meta.xml",
    ]);
  });

  it("doesn't declare Apex reserved words as identifiers", () => {
    const declared = g0()
      .files.filter((f) => f.path.endsWith(".cls"))
      .flatMap((f) => declaredNames(f.content));
    expect(declared.length).toBeGreaterThan(40);
    expect(declared.filter((n) => APEX_RESERVED.has(n.toLowerCase()))).toEqual([]);
  });

  it("produces Apex that parses, is ASCII and uses the project's API version", () => {
    const g = gen(FIELD);
    for (const f of g.files.filter((x) => x.path.endsWith(".cls"))) {
      const parsed = analyzeApexAst(f.content, { projectObjects: new Set(), kind: "class" });
      expect("errors" in parsed ? parsed.errors : []).toEqual([]);
      expect([...f.content].some((c) => c.charCodeAt(0) > 127)).toBe(false);
    }
    expect(fileOf(g, "ChangeTest.cls-meta.xml")).toContain("<apiVersion>62.0</apiVersion>");
  });

  it("meets flow entry criteria and passes validation rules in bulk tests", () => {
    const update = methodOf(fileOf(g0(), "ChangeTest.cls"), "bulkUpdateOpportunity");
    expect(update).toContain(
      "PreflightDataFactory.create('Opportunity', RECORD_COUNT, new Map<String, Object>{\n            'AccountId' => PreflightDataFactory.ANY_VALUE,\n            'StageName' => PreflightDataFactory.notValue('Closed Won')",
    );
    // The roll-up to Account is part of the cascade, so the records get a parent Account.
    expect(fileOf(g0(), "ChangeTest.cls")).toContain(
      "// NOTE: The records share one Account through AccountId, so roll-up Account.Total_Won_Amount__c runs on it.",
    );
    expect(update).toContain("'Contract_Signed_Date__c' => PreflightDataFactory.ANY_VALUE");
    expect(update).toContain("'StageName' => 'Closed Won'");
    expect(update).toContain("Database.update(records, false);");
  });

  it("links related records and fires the first hop in recursion tests", () => {
    const m = methodOf(fileOf(g0(), "ChangeTest.cls"), "recursionAccountContact");
    expect(m).toContain(
      "PreflightDataFactory.build('Contact', RECORD_COUNT, new Map<String, Object>{\n            'AccountId' => null",
    );
    expect(m).toContain("related[i].put('AccountId', records[i].Id);");
    expect(m).toContain("'Customer_Tier__c' => PreflightDataFactory.ANY_VALUE");
  });

  it("counts records a self-updating flow creates across two saves", () => {
    const m = methodOf(fileOf(g0(), "ChangeTest.cls"), "idempotentOpportunityClosedWonFollowup");
    expect(m).toContain("Integer created1First = [SELECT COUNT() FROM Task WHERE WhatId = :recordId];");
    expect(m).toContain("update record.getSObjectType().newSObject(recordId);");
    expect(m).toContain("System.assertEquals(created1First, created1Second");
  });

  it("sets up the validation-rule trap for invocable actions", () => {
    const m = methodOf(fileOf(g0(), "ChangeTest.cls"), "surfacesErrorsOpportunityCloserRequireContractSignedDate");
    expect(m).toContain("'Contract_Signed_Date__c' => null");
    expect(m).toContain("'StageName' => PreflightDataFactory.notValue('Closed Won')");
    expect(m).toContain("OpportunityCloser.closeWon(new List<Id>{ recordId });");
    expect(m).toContain("SObject beforeCall = [SELECT Id, StageName FROM Opportunity WHERE Id = :recordId];");
    expect(m).toContain("System.assert(surfaced || changed");
  });

  it("starts recursion tests from the changed object", () => {
    const g = gen(`${SRC}/triggers/ContactTrigger.trigger`);
    const m = methodOf(fileOf(g, "ChangeTest.cls"), "recursionContactAccount");
    expect(m).toContain("records[i].put('AccountId', related[i].Id);");
    expect(m).not.toContain(".touch(");
  });

  it("explains what it doesn't generate", () => {
    const g = gen(`${SRC}/permissionsets/Agent_Runtime_User.permissionset-meta.xml`);
    expect(g.tests).toEqual([]);
    expect(g.files).toEqual([]);
    expect(g.skipped.every((s) => s.kind === "permission-negative")).toBe(true);
    expect(g.skipped.length).toBeGreaterThan(0);
  });

  it("skips invocable actions with unsupported parameters", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-tg-"));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      writeFileSync(
        path.join(dir, SRC, "classes/OpportunityCloser.cls"),
        `public with sharing class OpportunityCloser {
    public class Request { @InvocableVariable public Id opportunityId; }
    @InvocableMethod
    public static void closeWon(List<Request> requests) {
        List<Opportunity> opps = new List<Opportunity>();
        for (Request r : requests) { Opportunity o = new Opportunity(Id = r.opportunityId); o.StageName = 'Closed Won'; opps.add(o); }
        update opps;
    }
}`,
      );
      const g = gen(FIELD, loadProject(dir));
      expect(g.skipped).toContainEqual({
        kind: "validation-collision",
        title: "OpportunityCloser.closeWon must surface validation errors on Opportunity",
        reason: "Invocable parameter List<Request> isn't supported yet (List<Id> or List<Opportunity> only).",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates names and sizes", () => {
    const { changes } = toChanges([{ file: FIELD, changeType: "modified" }]);
    const r = analyze({ model, changes });
    expect(() => generateTests(model, r, { prefix: "1bad" })).toThrow(/Invalid Apex class name/);
    expect(() => generateTests(model, r, { className: "Way_Too_Long_Name_For_An_Apex_Class_Test_Class" })).toThrow();
    expect(() => generateTests(model, r, { bulkSize: 0 })).toThrow(/bulkSize/);
    expect(generateTests(model, r, { prefix: "Acme", bulkSize: 50 }).files[2]!.content).toContain(
      "private static final Integer RECORD_COUNT = 50;",
    );
  });

  it("escapes Apex strings", () => {
    expect(apexString("it's a \\ path\nnext")).toBe("'it\\'s a \\\\ path\\nnext'");
  });

  it("suggests a check-only deployment run from the project directory", () => {
    const md = testsToMarkdown(g0(), {
      projectDir: "my project",
      sourceDirs: ["force-app"],
      outDir: "preflight-tests",
    });
    expect(md).toContain(
      "```bash\ncd 'my project'\nsf project deploy validate --source-dir force-app --source-dir preflight-tests \\\n" +
        "  --test-level RunSpecifiedTests --tests PreflightChangeTest --target-org <sandbox>\n```",
    );
    // Saved inside a package directory: no extra --source-dir, no cd.
    const inSource = testsToMarkdown(g0(), { projectDir: ".", sourceDirs: ["force-app", "libs"] });
    expect(inSource).toContain("```bash\nsf project deploy validate --source-dir force-app --source-dir libs \\\n");
  });

  it("runs end to end from the core API", () => {
    const { tests } = runTests({ projectDir: FIXTURE, files: [path.join(FIXTURE, FIELD)] });
    expect(tests.tests.length).toBe(5);
  });
});

/** Salesforce's reserved Apex keywords, which can't be used as identifiers. */
const APEX_RESERVED = new Set(
  `abstract activate and any array as asc autonomous begin bigdecimal blob boolean break bulk by byte
  case cast catch char class collect commit const continue currency date datetime decimal default
  delete desc do double else end enum exception exit export extends false final finally float for
  from global goto group having hint if implements import in inner insert instanceof int integer
  interface into join like limit list long loop map merge new not null nulls number object of on or
  outer override package parallel pragma private protected public retrieve return rollback select
  set short sobject sort static string super switch synchronized system testmethod then this throw
  time transaction trigger true try undelete update upsert using virtual void webservice when where
  while`.split(/\s+/),
);

class QuietListener extends ApexErrorListener {
  apexSyntaxError(): void {}
}

/** Names of the classes, methods, properties, parameters and variables a class declares. */
function declaredNames(source: string): string[] {
  const { parser } = ApexParserFactory.createLexerAndParser(source, new QuietListener());
  const names: string[] = [];
  const walk = (node: unknown) => {
    if (
      node instanceof ClassDeclarationContext ||
      node instanceof MethodDeclarationContext ||
      node instanceof PropertyDeclarationContext ||
      node instanceof FormalParameterContext ||
      node instanceof VariableDeclaratorContext ||
      node instanceof CatchClauseContext ||
      node instanceof EnhancedForControlContext
    ) {
      names.push(node.id().getText());
    }
    for (const child of (node as { children?: unknown[] }).children ?? []) walk(child);
  };
  walk(parser.compilationUnit());
  return names;
}

function g0() {
  return gen(FIELD);
}

describe("MCP generate_tests", () => {
  let client: Client;
  beforeAll(async () => {
    const server = createMcpServer({ root: FIXTURE, version: "0.0.0-test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterAll(async () => client.close());

  it("returns the summary and the Apex classes without writing files", async () => {
    const res = await client.callTool({ name: "generate_tests", arguments: { files: [FIELD] } });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(res.isError).toBeFalsy();
    expect(text).toContain("## Preflight tests: 5 generated, 1 skipped");
    expect(text).toContain("#### classes/PreflightChangeTest.cls\n\n```apex\n/**");
    expect(text).toContain("#### classes/PreflightDataFactory.cls-meta.xml\n\n```xml");
  });
});
