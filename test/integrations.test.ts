// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, loadProject } from "../src/core/index.js";
import { hostOf, parseIntegration } from "../src/core/integrations.js";
import { classifyPath } from "../src/core/project.js";
import type { Change, Finding } from "../src/core/types.js";

const base = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const legacyNc = (url: string, protocol = "Password") =>
  `<NamedCredential ${NS}><endpoint>${url}</endpoint><label>Pay</label><principalType>NamedUser</principalType><protocol>${protocol}</protocol></NamedCredential>`;
const newNc = (url: string, external: string) =>
  `<NamedCredential ${NS}><label>Pay</label><namedCredentialType>SecuredEndpoint</namedCredentialType><namedCredentialParameters><parameterName>Url</parameterName><parameterType>Url</parameterType><parameterValue>${url}</parameterValue></namedCredentialParameters><namedCredentialParameters><externalCredential>${external}</externalCredential><parameterName>ExternalCredential</parameterName><parameterType>Authentication</parameterType></namedCredentialParameters></NamedCredential>`;
const remoteSite = (url: string, active = true, insecure = false) =>
  `<RemoteSiteSetting ${NS}><disableProtocolSecurity>${insecure}</disableProtocolSecurity><isActive>${active}</isActive><url>${url}</url></RemoteSiteSetting>`;
const app = (scopes: string[], callback: string, secret = "") =>
  `<ConnectedApp ${NS}><label>App</label><oauthConfig><callbackUrl>${callback}</callbackUrl>${secret ? `<consumerSecret>${secret}</consumerSecret>` : ""}${scopes.map((s) => `<scopes>${s}</scopes>`).join("")}</oauthConfig></ConnectedApp>`;
const workflow = (url: string, session: boolean) =>
  `<Workflow ${NS}><outboundMessages><fullName>Send_Order</fullName><apiVersion>62.0</apiVersion><endpointUrl>${url}</endpointUrl><fields>Id</fields><fields>Total__c</fields><includeSessionId>${session}</includeSessionId><integrationUser>someone@example.com</integrationUser><name>Send Order</name><protected>false</protected><useDeadLetterQueue>false</useDeadLetterQueue></outboundMessages></Workflow>`;

describe("integration parsing", () => {
  it("reads endpoints and authentication from both named credential formats", () => {
    const c = classifyPath(`${base}namedCredentials/Pay.namedCredential-meta.xml`);
    expect(parseIntegration(c, legacyNc("https://api.pay.com/v1"))).toMatchObject({
      url: "https://api.pay.com/v1",
      auth: "NamedUser, Password",
    });
    expect(parseIntegration(c, newNc("https://api.pay.com", "Pay_Auth"))).toMatchObject({
      url: "https://api.pay.com",
      externalCredential: "Pay_Auth",
    });
    expect(hostOf("https://API.pay.com:443/x")).toBe("api.pay.com");
  });
});

describe("integrations in the analysis", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const run = (rel: string, baseXml: string | undefined, changeType: Change["changeType"] = "modified"): Finding[] =>
    analyze({
      model: loadProject(dir, { cache: false }),
      changes: [{ changeType, component: classifyPath(base + rel) }],
      readBase: () => baseXml,
    }).findings;
  const rules = (fs: Finding[]) => fs.map((f) => [f.rule, f.severity]);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-integrations-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(
      "classes/PayClient.cls",
      "public class PayClient { void a(){ HttpRequest r = new HttpRequest(); r.setEndpoint('callout:Pay/charges'); } void b(){ HttpRequest r = new HttpRequest(); r.setEndpoint('https://geo.example.org/lookup'); } }",
    );
    write(
      "objects/Order__c/fields/Total__c.field-meta.xml",
      "<CustomField><fullName>Total__c</fullName></CustomField>",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags a named credential that moves host, changes authentication or drops https", () => {
    write("namedCredentials/Pay.namedCredential-meta.xml", legacyNc("http://evil.example.net", "Oauth"));
    const fs = run("namedCredentials/Pay.namedCredential-meta.xml", legacyNc("https://api.pay.com"));
    expect(fs.filter((f) => f.rule.startsWith("integration")).map((f) => f.title)).toEqual([
      "Named credential Pay sends callouts over plain http",
      "Named credential Pay now points to evil.example.net instead of api.pay.com",
      "Named credential Pay authenticates differently",
    ]);
    expect(fs.find((f) => f.rule === "integration-insecure")?.files).toContain(`${base}classes/PayClient.cls`);
  });

  it("names the named credentials behind a changed external credential", () => {
    write("namedCredentials/Pay.namedCredential-meta.xml", newNc("https://api.pay.com", "Pay_Auth"));
    write(
      "externalCredentials/Pay_Auth.externalCredential-meta.xml",
      `<ExternalCredential ${NS}><authenticationProtocol>Custom</authenticationProtocol><label>A</label></ExternalCredential>`,
    );
    const [f] = run(
      "externalCredentials/Pay_Auth.externalCredential-meta.xml",
      `<ExternalCredential ${NS}><authenticationProtocol>Oauth</authenticationProtocol><label>A</label></ExternalCredential>`,
    ).filter((x) => x.rule === "integration-endpoint-changed");
    expect(f?.detail).toContain("Oauth → Custom");
    expect(f?.detail).toContain("Named credentials using it: Pay");
  });

  it("finds code that calls a host a removed or deactivated remote site allowed", () => {
    const fs = run("remoteSiteSettings/Geo.remoteSite-meta.xml", remoteSite("https://geo.example.org"), "deleted");
    const [f] = fs.filter((x) => x.rule === "integration-allowlist-removed");
    expect(f?.title).toBe("Remote site setting Geo no longer allows geo.example.org, which 1 file(s) still call");
    write("remoteSiteSettings/Geo.remoteSite-meta.xml", remoteSite("https://geo.example.org", false));
    expect(
      run("remoteSiteSettings/Geo.remoteSite-meta.xml", remoteSite("https://geo.example.org")).some(
        (x) => x.rule === "integration-allowlist-removed",
      ),
    ).toBe(true);
  });

  it("flags a remote site that turns off protocol security, and notes a newly allowed host", () => {
    write("remoteSiteSettings/Geo.remoteSite-meta.xml", remoteSite("http://maps.example.com", true, true));
    expect(rules(run("remoteSiteSettings/Geo.remoteSite-meta.xml", undefined, "added"))).toEqual(
      expect.arrayContaining([
        ["integration-insecure", "high"],
        ["integration-endpoint-changed", "low"],
      ]),
    );
  });

  it("rates connected app scopes and callbacks, and finds committed secrets", () => {
    write(
      "connectedApps/App.connectedApp-meta.xml",
      app(["Api", "Full", "RefreshToken"], "https://ok.example.com/cb http://new.example.com/cb", "s3cr3t"),
    );
    const fs = run("connectedApps/App.connectedApp-meta.xml", app(["Api"], "https://ok.example.com/cb"));
    expect(fs.filter((f) => f.rule !== "metadata-not-analyzed").map((f) => [f.rule, f.severity, f.title])).toEqual(
      expect.arrayContaining([
        ["integration-insecure", "high", "Connected app App has its consumer secret in source control"],
        ["connected-app-access", "high", "Connected app App requests more OAuth scopes: Full, RefreshToken"],
        [
          "connected-app-access",
          "high",
          "Connected app App accepts new OAuth callback URL(s): http://new.example.com/cb",
        ],
      ]),
    );
    expect(JSON.stringify(fs)).not.toContain("s3cr3t");
  });

  it("checks outbound messages in workflow files, and counts their fields as references", () => {
    write("workflows/Order__c.workflow-meta.xml", workflow("http://erp.example.com/in", true));
    const fs = run("workflows/Order__c.workflow-meta.xml", workflow("https://erp.example.com/in", false));
    expect(fs.filter((f) => f.rule === "integration-insecure").map((f) => f.title)).toEqual([
      "Outbound message Order__c.Send_Order sends a session ID to erp.example.com",
      "Outbound message Order__c.Send_Order posts to plain http",
    ]);
    expect(JSON.stringify(fs)).not.toContain("someone@example.com");
    const del = run("objects/Order__c/fields/Total__c.field-meta.xml", undefined, "deleted");
    expect(del.find((f) => f.rule === "deleted-still-referenced")?.detail).toContain(
      "OutboundMessage Order__c.Send_Order",
    );
  });
});
