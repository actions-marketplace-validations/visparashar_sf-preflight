import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeOrg,
  collectOrgContext,
  createSfRunner,
  loadProject,
  run,
  type SfRunner,
  toMarkdown,
} from "../src/core/index.js";
import { createMcpServer } from "../src/mcp.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const FIELD = path.join(
  FIXTURE,
  "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml",
);
const PERMSET = path.join(FIXTURE, "force-app/main/default/permissionsets/Agent_Runtime_User.permissionset-meta.xml");

const rec = (type: string, fields: Record<string, unknown>) => ({ attributes: { type, url: `/x/${type}` }, ...fields });

/** Recorded responses keyed by what the command/query asks for. */
function fakeRunner(overrides: Partial<Record<string, unknown | Error>> = {}): SfRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const respond = (k: string, value: unknown) => {
    const o = overrides[k];
    if (o instanceof Error) throw o;
    return o ?? value;
  };
  const runner = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "org" && args[1] === "display") return respond("display", { id: "00D000000000001", alias: "dev" });
    if (args[0] === "org" && args[1] === "list") {
      return respond("counts", [
        { name: "Account", count: 120000 },
        { name: "Opportunity", count: 2500000 },
      ]);
    }
    const q = args[args.indexOf("--query") + 1] ?? "";
    const records = (r: unknown[]) => ({ records: r, totalSize: r.length, done: true });
    if (q.includes("FROM EntityDefinition")) {
      return respond(
        "entities",
        records([
          rec("EntityDefinition", { QualifiedApiName: "Account", DurableId: "Account", Label: "Account" }),
          rec("EntityDefinition", { QualifiedApiName: "Contact", DurableId: "Contact", Label: "Contact" }),
          rec("EntityDefinition", { QualifiedApiName: "Opportunity", DurableId: "Opportunity", Label: "Opportunity" }),
        ]),
      );
    }
    if (q.includes("FROM InstalledSubscriberPackage")) {
      return respond(
        "packages",
        records([
          rec("InstalledSubscriberPackage", {
            SubscriberPackage: rec("SubscriberPackage", { NamespacePrefix: "SBQQ", Name: "Salesforce CPQ" }),
            SubscriberPackageVersion: rec("SubscriberPackageVersion", {
              MajorVersion: 252,
              MinorVersion: 3,
              PatchVersion: 0,
            }),
          }),
        ]),
      );
    }
    if (q.includes("FROM FlowDefinitionView")) {
      return respond(
        "flows",
        records([
          // in the project → ignored
          rec("FlowDefinitionView", {
            ApiName: "Opportunity_Closed_Won_Followup",
            TriggerType: "RecordAfterSave",
            RecordTriggerType: "CreateAndUpdate",
            TriggerObjectOrEventId: "Opportunity",
            TriggerObjectOrEventLabel: "Opportunity",
          }),
          // managed, matched by label
          rec("FlowDefinitionView", {
            ApiName: "Account_Quote_Sync",
            TriggerType: "RecordAfterSave",
            RecordTriggerType: "Update",
            TriggerObjectOrEventId: "0kx000000000001",
            TriggerObjectOrEventLabel: "Account",
            NamespacePrefix: "SBQQ",
          }),
          // not an impacted object → ignored
          rec("FlowDefinitionView", {
            ApiName: "Lead_Router",
            TriggerType: "RecordAfterSave",
            RecordTriggerType: "Create",
            TriggerObjectOrEventId: "Lead",
            TriggerObjectOrEventLabel: "Lead",
          }),
          // screen flow → ignored
          rec("FlowDefinitionView", { ApiName: "Intake", TriggerType: null, TriggerObjectOrEventId: null }),
        ]),
      );
    }
    if (q.includes("FROM ApexTrigger")) {
      return respond(
        "triggers",
        records([
          rec("ApexTrigger", { Name: "ContactTrigger", TableEnumOrId: "Contact", UsageAfterUpdate: true }),
          // only fires on delete, which this change never reaches → filtered out
          rec("ApexTrigger", { Name: "ContactCleanup", TableEnumOrId: "Contact", UsageAfterDelete: true }),
          rec("ApexTrigger", {
            Name: "LegacyOpportunityTrigger",
            TableEnumOrId: "Opportunity",
            UsageBeforeUpdate: true,
            UsageAfterInsert: true,
          }),
        ]),
      );
    }
    if (q.includes("FROM ValidationRule")) {
      return respond(
        "vrs",
        records([
          rec("ValidationRule", { ValidationName: "Require_Contract_Signed_Date", EntityDefinitionId: "Opportunity" }),
          rec("ValidationRule", { ValidationName: "Contact_Email_Required", EntityDefinitionId: "Contact" }),
        ]),
      );
    }
    if (q.includes("FROM PermissionSet WHERE")) {
      return respond(
        "permsets",
        records([rec("PermissionSet", { Id: "0PS000000000001AAA", Name: "Agent_Runtime_User" })]),
      );
    }
    // Runtime user of the affected agent.
    if (q.includes("FROM User WHERE Username")) {
      return respond("agentUser", records([rec("User", { Id: "005000000000001AAA", IsActive: true })]));
    }
    if (q.includes("FROM PermissionSetAssignment WHERE AssigneeId")) {
      return respond(
        "agentAssignments",
        records([
          rec("PermissionSetAssignment", {
            PermissionSetId: "0PS000000000002AAA",
            PermissionSet: rec("PermissionSet", {
              PermissionsModifyAllData: false,
              PermissionsViewAllData: true,
              PermissionsAuthorApex: false,
            }),
          }),
        ]),
      );
    }
    if (q.includes("FROM ObjectPermissions")) {
      return respond(
        "objectPerms",
        records([
          rec("ObjectPermissions", {
            SobjectType: "Account",
            PermissionsRead: true,
            PermissionsCreate: false,
            PermissionsEdit: true,
            PermissionsDelete: false,
            PermissionsModifyAllRecords: false,
          }),
        ]),
      );
    }
    if (q.includes("FROM ApexClass WHERE")) {
      return respond(
        "apexClasses",
        records([rec("ApexClass", { Id: "01p000000000001AAA", Name: "OpportunityCloser" })]),
      );
    }
    if (q.includes("FROM SetupEntityAccess")) return respond("classAccess", records([]));
    if (q.includes("FROM PermissionSetAssignment")) {
      return respond(
        "assignments",
        records([rec("AggregateResult", { PermissionSetId: "0PS000000000001AAA", n: 37 })]),
      );
    }
    throw new Error(`unexpected sf call: ${args.join(" ")}`);
  }) as SfRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

describe("org enrichment", () => {
  it("collects record counts, org-only automation, packages and assignments", () => {
    const runner = fakeRunner();
    const result = run({ projectDir: FIXTURE, files: [FIELD, PERMSET], org: "dev", sfRunner: runner });
    const org = result.org!;
    expect(org.org).toBe("dev");
    expect(org.errors).toEqual([]);
    expect(org.recordCounts).toEqual({ Account: 120000, Opportunity: 2500000 });
    expect(org.packages).toEqual([{ namespace: "SBQQ", name: "Salesforce CPQ", version: "252.3.0" }]);
    expect(
      org.orgOnlyAutomation.map((a) => `${a.kind}:${a.name}:${a.object}:${a.when.join("|")}:${a.packageName ?? ""}`),
    ).toEqual([
      "Flow:Account_Quote_Sync:Account:after update:Salesforce CPQ",
      "ApexTrigger:LegacyOpportunityTrigger:Opportunity:after insert|before update:",
      "ValidationRule:Contact_Email_Required:Contact:validation:",
    ]);
    expect(org.assignments).toEqual([{ kind: "PermissionSet", name: "Agent_Runtime_User", activeUsers: 37 }]);
  });

  it("only issues read-only commands, always against the requested org", () => {
    const runner = fakeRunner();
    run({ projectDir: FIXTURE, files: [FIELD, PERMSET], org: "dev", sfRunner: runner });
    for (const args of runner.calls) {
      expect(["org display", "org list", "data query"]).toContain(args.slice(0, 2).join(" "));
      expect(args[args.indexOf("--target-org") + 1]).toBe("dev");
      const q = args[args.indexOf("--query") + 1];
      if (args[0] === "data") expect(q).toMatch(/^SELECT /);
    }
  });

  it("turns org context into findings, annotations and a report section", () => {
    const result = run({ projectDir: FIXTURE, files: [FIELD, PERMSET], org: "dev", sfRunner: fakeRunner() });
    const orgOnly = result.findings.filter((f) => f.rule === "org-only-automation");
    expect(orgOnly.map((f) => `${f.severity}:${f.object}`).sort()).toEqual([
      "low:Account",
      "medium:Contact",
      "medium:Opportunity",
    ]);
    const opp = orgOnly.find((f) => f.object === "Opportunity")!;
    expect(opp.detail).toContain("`sf project retrieve start --metadata ApexTrigger:LegacyOpportunityTrigger`");
    const contact = orgOnly.find((f) => f.object === "Contact")!;
    expect(contact.detail).toContain("--metadata ValidationRule:Contact.Contact_Email_Required");
    expect(orgOnly.find((f) => f.object === "Account")!.detail).not.toContain("retrieve start");
    const escalation = result.findings.find((f) => f.rule === "permission-escalation")!;
    expect(escalation.detail).toContain("In dev it is assigned to 37 active user(s).");
    const bulk = result.suggestedTests.find((t) => t.kind === "bulk" && t.object === "Opportunity")!;
    expect(bulk.description).toContain("dev has 2,500,000 Opportunity records");
    const md = toMarkdown(result);
    expect(md).toContain("### Org context: `dev`");
    expect(md).toContain("| Opportunity | 2,500,000 | trigger `LegacyOpportunityTrigger` |");
    expect(md).toContain("`Agent_Runtime_User` is assigned to **37** active user(s)");
  });

  it("explains how the change reaches each org-only automation", () => {
    const result = run({ projectDir: FIXTURE, files: [FIELD], org: "dev", sfRunner: fakeRunner() });
    const orgOnly = result.findings.filter((f) => f.rule === "org-only-automation");
    const byObject = (o: string) => orgOnly.find((f) => f.object === o)!.detail;
    expect(byObject("Contact")).toContain(
      "This change reaches Contact (update) via flow Account_Sync_Tier_To_Contacts, so these run too.",
    );
    expect(byObject("Account")).toContain(
      "Account (update) via roll-up Account.Total_Won_Amount__c, trigger ContactTrigger",
    );
    expect(byObject("Opportunity")).toContain(
      "Opportunity (update) via the change to Opportunity.Contract_Signed_Date__c",
    );
    for (const f of orgOnly) {
      expect(f.detail).toBe(f.detail.trim());
      expect(f.detail).not.toContain("  ");
      expect(f.detail).not.toContain("ContactCleanup");
    }
  });

  it("lists every impacted object in the org table and explains missing counts", () => {
    const md = toMarkdown(run({ projectDir: FIXTURE, files: [FIELD], org: "dev", sfRunner: fakeRunner() }));
    expect(md).toContain("| Task | n/a | — |");
    expect(md).toContain("| Contact | n/a | VR `Contact_Email_Required` |");
    expect(md).toContain("n/a: Salesforce's record-count API returned no count for this object.");
    expect(md).toContain("plus read-only org context");
  });

  it("words bulk tests for small orgs", () => {
    const runner = fakeRunner({ counts: [{ name: "Opportunity", count: 31 }] });
    const result = run({ projectDir: FIXTURE, files: [FIELD], org: "dev", sfRunner: runner });
    const bulk = result.suggestedTests.find((t) => t.kind === "bulk" && t.object === "Opportunity")!;
    expect(bulk.description).toContain("(dev has 31 Opportunity records; 200 is still the minimum bulk size to test)");
  });

  it("never puts a username in the report", () => {
    const username = "integration.user@example.com";
    const withAlias = run({
      projectDir: FIXTURE,
      files: [FIELD, PERMSET],
      org: username,
      sfRunner: fakeRunner({ display: { alias: "uat", username } }),
    });
    expect(withAlias.org!.org).toBe("uat");
    expect(toMarkdown(withAlias)).toContain("### Org context: `uat`");

    const noAlias = run({
      projectDir: FIXTURE,
      files: [FIELD, PERMSET],
      org: username,
      sfRunner: fakeRunner({ display: { username }, flows: new Error(`INSUFFICIENT_ACCESS for ${username}`) }),
    });
    expect(noAlias.org!.org).toBe("target org");
    expect(noAlias.org!.errors).toEqual(["flows: INSUFFICIENT_ACCESS for <username>"]);
    const md = toMarkdown(noAlias);
    expect(md).toContain("### Org context\n");
    expect(md).toContain("run in the target org but aren't in this project");
    expect(md).toContain("In the target org it is assigned to 37 active user(s).");
    for (const r of [withAlias, noAlias]) {
      expect(JSON.stringify(r)).not.toContain(username);
      expect(toMarkdown(r)).not.toContain(username);
    }
  });

  it("checks the runtime user of each affected agent", () => {
    const result = run({ projectDir: FIXTURE, files: [FIELD], org: "dev", sfRunner: fakeRunner() });
    expect(result.org!.agentUsers).toEqual([
      {
        agent: "Sales_Agent",
        agentLabel: "Sales Agent",
        status: "checked",
        missing: [],
        missingClasses: ["OpportunityCloser"],
        broad: ["View All Data"],
      },
    ]);
    const access = result.findings.find((f) => f.rule === "agent-runtime-access")!;
    expect(access.severity).toBe("high");
    expect(access.title).toBe("Sales Agent's runtime user lacks access the affected actions need in dev");
    expect(access.detail).toContain("Missing: access to Apex class OpportunityCloser (needed by Close Opportunity).");
    const broad = result.findings.find((f) => f.rule === "agent-runtime-overprivileged")!;
    expect(broad.title).toBe("Sales Agent's runtime user has broad access in dev: View All Data");
    const md = toMarkdown(result);
    expect(md).toContain(
      "- Sales Agent's runtime user: **lacks** access to class OpportunityCloser; holds View All Data.",
    );
    // The runtime user's username is only used in the query.
    for (const out of [JSON.stringify(result), md]) expect(out).not.toContain("sales.agent@example.com");
  });

  it("checks object access for flows, which run as the agent's user", () => {
    const VR = path.join(
      FIXTURE,
      "force-app/main/default/objects/Account/validationRules/Tier_Required_For_Customers.validationRule-meta.xml",
    );
    const runner = fakeRunner({
      classAccess: { records: [{ SetupEntityId: "01p000000000001AAA" }] },
      agentAssignments: { records: [{ PermissionSetId: "0PS000000000002AAA", PermissionSet: {} }] },
      objectPerms: { records: [] },
    });
    const result = run({ projectDir: FIXTURE, files: [VR], org: "dev", sfRunner: runner });
    const service = result.org!.agentUsers!.find((u) => u.agent === "Service_Agent")!;
    expect(service.missing).toEqual([{ object: "Account", access: ["read", "edit"] }]);
    const sales = result.org!.agentUsers!.find((u) => u.agent === "Sales_Agent")!;
    expect(sales).toMatchObject({ missing: [], missingClasses: [], broad: [] });
    const finding = result.findings.find((f) => f.title.startsWith("Service Agent's runtime user lacks"))!;
    expect(finding.detail).toContain("Missing: read/edit on Account (needed by Update Tier).");
  });

  it("keeps the runtime user's username out of query errors", () => {
    const username = "sales.agent@example.com.sample";
    const result = run({
      projectDir: FIXTURE,
      files: [FIELD],
      org: "dev",
      sfRunner: fakeRunner({
        agentUser: new Error(
          `sf data failed: Command failed: sf data query --query SELECT Id, IsActive FROM User WHERE Username = '${username}' LIMIT 1`,
        ),
      }),
    });
    expect(result.org!.errors).toEqual([
      "runtime user of agent Sales Agent: sf data failed: Command failed: sf data query --query SELECT Id, IsActive FROM User WHERE Username = '<runtime user>' LIMIT 1",
    ]);
    expect(JSON.stringify(result)).not.toContain("sales.agent");
    expect(toMarkdown(result)).not.toContain("sales.agent");
  });

  it("reports runtime users that are missing or inactive", () => {
    const missing = run({
      projectDir: FIXTURE,
      files: [FIELD],
      org: "dev",
      sfRunner: fakeRunner({ agentUser: { records: [] } }),
    });
    expect(missing.findings.find((f) => f.rule === "agent-runtime-access")).toMatchObject({
      severity: "medium",
      title: "Sales Agent's runtime user is not found in dev",
    });
    const inactive = run({
      projectDir: FIXTURE,
      files: [FIELD],
      org: "dev",
      sfRunner: fakeRunner({ agentUser: { records: [{ Id: "005000000000001AAA", IsActive: false }] } }),
    });
    expect(inactive.findings.find((f) => f.rule === "agent-runtime-access")).toMatchObject({
      severity: "high",
      title: "Sales Agent's runtime user is inactive in dev",
    });
  });

  it("keeps going when one query fails and reports it", () => {
    const runner = fakeRunner({ flows: new Error("sObject type 'FlowDefinitionView' is not supported.") });
    const result = run({ projectDir: FIXTURE, files: [FIELD], org: "dev", sfRunner: runner });
    expect(result.org!.errors).toEqual(["flows: sObject type 'FlowDefinitionView' is not supported."]);
    expect(result.org!.orgOnlyAutomation.some((a) => a.kind === "ApexTrigger")).toBe(true);
    expect(toMarkdown(result)).toContain("Org queries that failed");
  });

  it("fails clearly when the org can't be used", () => {
    const runner = fakeRunner({ display: new Error("No authorization information found for nope.") });
    expect(() => run({ projectDir: FIXTURE, files: [FIELD], org: "nope", sfRunner: runner })).toThrow(
      'Could not use org "nope": No authorization information found for nope.',
    );
  });

  it("matches custom objects referenced by id", () => {
    const model = loadProject(FIXTURE);
    const runner: SfRunner = (args) => {
      const q = args[args.indexOf("--query") + 1] ?? "";
      if (args[1] === "display" || args[1] === "list") return args[1] === "list" ? [] : {};
      if (q.includes("EntityDefinition")) {
        return { records: [{ QualifiedApiName: "Invoice__c", DurableId: "01I000000000ABC", Label: "Invoice" }] };
      }
      if (q.includes("ApexTrigger"))
        return { records: [{ Name: "InvoiceTrigger", TableEnumOrId: "01I000000000ABC", UsageAfterInsert: true }] };
      return { records: [] };
    };
    const ctx = collectOrgContext(
      model,
      { impactedObjects: ["Invoice__c"], changes: [] } as unknown as Parameters<typeof collectOrgContext>[1],
      { org: "dev", runner },
    );
    expect(ctx.orgOnlyAutomation).toEqual([
      {
        kind: "ApexTrigger",
        name: "InvoiceTrigger",
        object: "Invoice__c",
        when: ["after insert"],
        namespace: undefined,
        packageName: undefined,
      },
    ]);
  });

  it("validates org aliases", () => {
    for (const ok of ["dev", "my-sandbox", "user@example.com.uat", "DevHub_1"]) expect(assertSafeOrg(ok)).toBe(ok);
    for (const bad of ["--target-org", "a b", "", "x;rm -rf /", "-p"])
      expect(() => assertSafeOrg(bad)).toThrow(/Invalid org/);
  });
});

describe("sf runner (real subprocess)", () => {
  let bin: string;
  const originalPath = process.env.PATH;
  beforeAll(() => {
    bin = mkdtempSync(path.join(tmpdir(), "sf-preflight-sf-"));
    const script = path.join(bin, "sf");
    writeFileSync(
      script,
      `#!/bin/sh
case "$*" in
  *"org display"*"--target-org good"*) echo '{"status":0,"result":{"id":"00D"}}' ;;
  *"data query"*) printf '%s' '{"status":0,"result":{"records":[{"attributes":{"type":"Account"},"Name":"x"}],"totalSize":1,"done":true}}' ;;
  *) echo '{"status":1,"name":"NamedOrgNotFoundError","message":"No authorization information found for bad."}'; exit 1 ;;
esac
`,
    );
    chmodSync(script, 0o755);
  });
  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it("parses results, strips attributes and surfaces sf error messages", () => {
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const sf = createSfRunner();
    expect(sf(["org", "display", "--target-org", "good"])).toEqual({ id: "00D" });
    expect(() => sf(["org", "display", "--target-org", "bad"])).toThrow("No authorization information found for bad.");
  });

  it("explains how to proceed when sf is not installed", () => {
    process.env.PATH = bin.replace(/[^/]+$/, "definitely-missing");
    expect(() => createSfRunner()(["org", "display"])).toThrow(/Salesforce CLI \(`sf`\) not found/);
  });
});

describe("MCP org argument", () => {
  let client: Client;
  beforeAll(async () => {
    const server = createMcpServer({ root: FIXTURE, version: "0.0.0-test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterAll(async () => client.close());

  it("rejects unsafe org values as a tool error", async () => {
    const res = await client.callTool({
      name: "analyze_change",
      arguments: { files: ["force-app/main/default/classes/OpportunityCloser.cls"], org: "--upload-pack=x" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain("Invalid org alias");
  });
});
