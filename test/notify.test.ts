// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";
import {
  alertFromResult,
  assertSafeWebhook,
  detectTarget,
  payloadFor,
  plain,
  readResult,
  sendWebhook,
  shouldNotify,
  slackEscape,
} from "../src/core/notify.js";

const sample = path.resolve("fixtures/sample-org");
const field = path.join(
  sample,
  "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml",
);
const result = () => analyzeChange({ projectDir: sample, files: [field] }).result;

describe("alert content", () => {
  it("summarizes a real result: worst findings first, counts, components", () => {
    const a = alertFromResult(result(), {
      source: "o/r PR #3",
      link: { label: "Open PR", url: "https://github.com/o/r/pull/3" },
    });
    expect(a.risk).toBe("high");
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.items.length).toBeLessThanOrEqual(5);
    expect(a.items[0]?.severity).toBe("high");
    expect(a.summary).toMatch(/high/);
    expect(a.components).toContain("Opportunity.Contract_Signed_Date__c");
    expect(a.link?.url).toBe("https://github.com/o/r/pull/3");
  });

  it("drops a link that is not https", () => {
    expect(alertFromResult(result(), { link: { label: "x", url: "javascript:alert(1)" } }).link).toBeUndefined();
    expect(alertFromResult(result(), { link: { label: "x", url: "http://example.com" } }).link).toBeUndefined();
  });

  it("decides when to send", () => {
    const r = result();
    expect(shouldNotify(r, "high")).toBe(true);
    expect(shouldNotify({ ...r, summary: { ...r.summary, risk: "low" } }, "high")).toBe(false);
    expect(shouldNotify({ ...r, summary: { ...r.summary, risk: "medium" } }, "medium")).toBe(true);
    expect(shouldNotify({ ...r, summary: { ...r.summary, risk: "low" } }, "always")).toBe(true);
    expect(shouldNotify({ ...r, gate: { status: "fail" } as never }, "gate-fail")).toBe(true);
    expect(shouldNotify({ ...r, gate: { status: "pass" } as never }, "gate-fail")).toBe(false);
  });

  it("only accepts an sf-preflight report", () => {
    expect(() => readResult({})).toThrow(/Not an sf-preflight/);
    expect(() => readResult(null)).toThrow();
    expect(readResult(result()).summary.risk).toBe("high");
  });
});

describe("untrusted text", () => {
  it("cleans control characters and limits length", () => {
    expect(plain("a\u0000b\nc‮d")).toBe("a b c d");
    expect(plain("x".repeat(500), 20)).toHaveLength(20);
  });

  it("stops a crafted component name from making a Slack link or ping", () => {
    const evil = "<!channel> <https://evil.example|click> `x` *y*";
    const r = result();
    r.changes[0]!.component.name = evil;
    const payload = JSON.stringify(payloadFor("slack", alertFromResult(r)));
    expect(payload).not.toContain("<!channel>");
    expect(payload).not.toContain("<https://evil");
    expect(payload).toContain("&lt;!channel&gt;");
    expect(slackEscape("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("keeps markdown links out of Teams text", () => {
    const r = result();
    r.findings[0]!.title = "see [here](https://evil.example) now";
    const card = JSON.stringify(payloadFor("teams", alertFromResult(r)));
    expect(card).not.toContain("](https://evil");
  });

  it("builds a Teams adaptive card", () => {
    const p = payloadFor(
      "teams",
      alertFromResult(result(), { link: { label: "Open", url: "https://example.com/x" } }),
    ) as {
      attachments: { contentType: string; content: { type: string; actions: unknown[] } }[];
    };
    expect(p.attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(p.attachments[0]?.content.type).toBe("AdaptiveCard");
    expect(p.attachments[0]?.content.actions).toHaveLength(1);
  });

  it("holds no file paths from the machine", () => {
    const text = JSON.stringify(payloadFor("generic", alertFromResult(result())));
    expect(text).not.toContain(sample);
  });
});

describe("webhook URL", () => {
  it.each([
    "http://hooks.slack.com/services/T/B/x",
    "https://user:pw@hooks.slack.com/services/x",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.1.2.3/hook",
    "https://192.168.0.5/hook",
    "https://172.20.0.1/hook",
    "https://169.254.169.254/latest",
    "https://[::1]/hook",
    "https://printer.local/hook",
    "https://db.internal/hook",
    "not a url",
  ])("refuses %s, without repeating it", (u) => {
    try {
      assertSafeWebhook(u);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("pw@");
      expect((e as Error).message).not.toContain(u);
      expect((e as Error).message).not.toBe("should have thrown");
    }
  });

  it("recognizes Slack, Teams and the rest", () => {
    expect(detectTarget(assertSafeWebhook("https://hooks.slack.com/services/T/B/x"))).toBe("slack");
    expect(detectTarget(assertSafeWebhook("https://prod-12.westus.logic.azure.com/workflows/x"))).toBe("teams");
    expect(detectTarget(assertSafeWebhook("https://contoso.webhook.office.com/webhookb2/x"))).toBe("teams");
    expect(detectTarget(assertSafeWebhook("https://example.com/hook"))).toBe("generic");
  });
});

describe("sending", () => {
  const url = new URL("https://hooks.slack.com/services/SECRET/PATH");
  const fast = { retryDelayMs: 1 };

  it("posts JSON and does not follow redirects", async () => {
    let seen: { init?: RequestInit } = {};
    const ok = await sendWebhook(
      url,
      { a: 1 },
      {
        ...fast,
        fetchImpl: (async (_u: unknown, init?: RequestInit) => {
          seen = { init };
          return new Response("ok", { status: 200 });
        }) as typeof fetch,
      },
    );
    expect(ok.ok).toBe(true);
    expect(seen.init?.redirect).toBe("error");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ a: 1 });
  });

  it("retries once on a server error, then reports it without the URL", async () => {
    let calls = 0;
    const res = await sendWebhook(
      url,
      {},
      {
        ...fast,
        fetchImpl: (async () => {
          calls++;
          return new Response("boom", { status: 503 });
        }) as typeof fetch,
      },
    );
    expect(calls).toBe(2);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("hooks.slack.com");
    expect(res.error).not.toContain("SECRET");
  });

  it("does not retry a client error", async () => {
    let calls = 0;
    const res = await sendWebhook(
      url,
      {},
      {
        ...fast,
        fetchImpl: (async () => {
          calls++;
          return new Response("no", { status: 404 });
        }) as typeof fetch,
      },
    );
    expect(calls).toBe(1);
    expect(res.status).toBe(404);
  });

  it("reports a network failure without the URL or the cause", async () => {
    const res = await sendWebhook(
      url,
      {},
      {
        ...fast,
        fetchImpl: (async () => {
          throw new Error("connect ECONNREFUSED https://hooks.slack.com/services/SECRET/PATH");
        }) as typeof fetch,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("SECRET");
  });
});

describe("preflight notify", () => {
  let dir: string;
  let report: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-notify-"));
    report = path.join(dir, "report.json");
    writeFileSync(report, JSON.stringify(result()));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["dist/cli.js", "notify", "--result", report, ...args], {
      encoding: "utf8",
      env: { ...process.env, PREFLIGHT_WEBHOOK_URL: "", ...env },
    });

  it("prints the message with --dry-run and never needs a URL", () => {
    const r = run(["--dry-run", "--target", "slack"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).payload.blocks.length).toBeGreaterThan(0);
  });

  it("asks for the URL, from the environment only", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PREFLIGHT_WEBHOOK_URL");
  });

  it("says nothing is sent below the threshold", () => {
    const low = JSON.parse(JSON.stringify(result()));
    low.summary.risk = "low";
    writeFileSync(report, JSON.stringify(low));
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("No alert");
  });

  it("refuses an unsafe URL without printing it", () => {
    const r = run([], { PREFLIGHT_WEBHOOK_URL: "http://10.0.0.1/secret-token" });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("secret-token");
  });
});
