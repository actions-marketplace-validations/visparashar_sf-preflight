// SPDX-License-Identifier: Apache-2.0
import type { AnalysisResult, Severity } from "./types.js";

/**
 * Alerts: a short message about a risky change, sent to Slack, Microsoft Teams or any webhook.
 *
 * Safety rules:
 *  - The webhook URL is a secret. It is read from the environment by the caller, never from a
 *    policy file (a pull request could point it somewhere else) and never printed.
 *  - Everything in a message that came from the repository (file names, component names, finding
 *    titles) is treated as untrusted text: control characters removed, length limited, and
 *    Slack's markup characters escaped so a crafted name cannot make a link or ping a channel.
 *  - Messages hold component names, rule titles and counts. No record data, no org user names.
 */

export type NotifyTarget = "slack" | "teams" | "generic";
export type NotifyLevel = "low" | "medium" | "high" | "gate-fail" | "always";

export interface Alert {
  /** The overall risk. */
  risk: "high" | "medium" | "low";
  title: string;
  /** One line of counts: "3 high · 5 medium · 12 components". */
  summary: string;
  /** The most important findings, worst first. */
  items: { severity: Severity; text: string }[];
  /** Changed components, shortened. */
  components: string[];
  /** Further findings and components not listed above. */
  more: number;
  gate?: "pass" | "fail";
  link?: { label: string; url: string };
  /** Where the alert came from, e.g. "owner/repo PR #12". */
  source?: string;
}

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };
const MAX_ITEMS = 5;
const MAX_COMPONENTS = 6;

/** Text from the repository, made safe to show: no control characters, one line, limited length. */
export function plain(text: unknown, max = 160): string {
  // Control, format (zero-width and bidi marks) and line/paragraph separator characters.
  const s = String(text ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Slack treats & < > as markup (links, @channel, mentions): escape them. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whether a result is serious enough to send for this level. */
export function shouldNotify(result: Pick<AnalysisResult, "summary" | "gate">, level: NotifyLevel): boolean {
  if (level === "always") return true;
  if (level === "gate-fail") return result.gate?.status === "fail";
  return (RANK[result.summary.risk] ?? 0) >= (RANK[level] ?? 0);
}

/** Build the alert from an analysis result. `source` and `link` come from the caller (CI context). */
export function alertFromResult(
  result: AnalysisResult,
  opts: { link?: { label: string; url: string }; source?: string; title?: string } = {},
): Alert {
  const by = result.summary.findingsBySeverity;
  const findings = [...result.findings]
    .filter((f) => f.severity === "high" || f.severity === "medium")
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
  const names = [...new Set(result.changes.map((c) => plain(c.component.name, 80)))];
  const counts = [
    by.high ? `${by.high} high` : "",
    by.medium ? `${by.medium} medium` : "",
    `${result.summary.changedComponents} changed component${result.summary.changedComponents === 1 ? "" : "s"}`,
    result.summary.impactedObjects
      ? `${result.summary.impactedObjects} object${result.summary.impactedObjects === 1 ? "" : "s"} affected`
      : "",
  ].filter(Boolean);
  return {
    risk: result.summary.risk,
    title: plain(opts.title ?? `${result.summary.risk.toUpperCase()} risk Salesforce change`, 100),
    summary: counts.join(" · "),
    items: findings.slice(0, MAX_ITEMS).map((f) => ({ severity: f.severity, text: plain(f.title, 200) })),
    components: names.slice(0, MAX_COMPONENTS),
    more: Math.max(0, findings.length - MAX_ITEMS) + Math.max(0, names.length - MAX_COMPONENTS),
    gate: result.gate?.status,
    link:
      opts.link && /^https:\/\//i.test(opts.link.url)
        ? { label: plain(opts.link.label, 60), url: opts.link.url }
        : undefined,
    source: opts.source ? plain(opts.source, 120) : undefined,
  };
}

/** Teams renders a little markdown in text blocks: stop repository text from forming links or emphasis. */
const teamsText = (t: string) =>
  t
    .replace(/[[\]()*_`~<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const EMOJI: Record<string, string> = {
  high: ":red_circle:",
  medium: ":large_orange_circle:",
  low: ":large_yellow_circle:",
};

/** Slack incoming-webhook payload (Block Kit). */
export function slackPayload(a: Alert): unknown {
  const lines = a.items.map((i) => `• *${i.severity}*: ${slackEscape(i.text)}`);
  const comps = a.components.map((c) => `\`${slackEscape(c).replace(/`/g, "'")}\``).join(", ");
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${a.title}`.slice(0, 150) } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${EMOJI[a.risk] ?? ""} *${slackEscape(a.summary)}*${a.gate ? ` · gate ${a.gate === "fail" ? "*failed*" : "passed"}` : ""}${a.source ? `\n${slackEscape(a.source)}` : ""}`,
      },
    },
  ];
  if (lines.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } });
  if (comps) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Changed: ${comps}${a.more ? ` and ${a.more} more` : ""}` }],
    });
  }
  if (a.link) {
    blocks.push({
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: a.link.label }, url: a.link.url }],
    });
  }
  // `text` is the fallback shown in notifications.
  return { text: `${a.title}: ${a.summary}`, blocks };
}

/** Microsoft Teams (Workflows "post to a channel when a webhook request is received") payload: an Adaptive Card. */
export function teamsPayload(a: Alert): unknown {
  const colour = a.risk === "high" ? "Attention" : a.risk === "medium" ? "Warning" : "Default";
  const body: unknown[] = [
    { type: "TextBlock", text: teamsText(a.title), weight: "Bolder", size: "Medium", wrap: true, color: colour },
    {
      type: "TextBlock",
      text: `${teamsText(a.summary)}${a.gate ? ` · gate ${a.gate === "fail" ? "failed" : "passed"}` : ""}`,
      wrap: true,
    },
  ];
  if (a.source)
    body.push({ type: "TextBlock", text: teamsText(a.source), isSubtle: true, wrap: true, spacing: "None" });
  if (a.items.length) {
    body.push({
      type: "FactSet",
      facts: a.items.map((i) => ({ title: i.severity, value: teamsText(i.text) })),
    });
  }
  if (a.components.length) {
    body.push({
      type: "TextBlock",
      text: `Changed: ${a.components.map(teamsText).join(", ")}${a.more ? ` and ${a.more} more` : ""}`,
      isSubtle: true,
      wrap: true,
    });
  }
  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
  if (a.link) card.actions = [{ type: "Action.OpenUrl", title: a.link.label, url: a.link.url }];
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] };
}

/** The alert itself, for any other receiver. */
export function genericPayload(a: Alert): unknown {
  return { tool: "sf-preflight", ...a };
}

export function payloadFor(target: NotifyTarget, a: Alert): unknown {
  return target === "slack" ? slackPayload(a) : target === "teams" ? teamsPayload(a) : genericPayload(a);
}

// ---- Sending ----------------------------------------------------------------------------

const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * A webhook URL must be https, carry no credentials, and not point at this machine or a private
 * network. Returns the URL; throws a message that never repeats the URL (it is a secret).
 */
export function assertSafeWebhook(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("The webhook URL must use https.");
  if (url.username || url.password) throw new Error("The webhook URL must not contain a user name or password.");
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    PRIVATE_V4.test(bare) ||
    bare === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(bare) ||
    /^fe80:/i.test(bare)
  ) {
    throw new Error("The webhook URL points at this machine or a private network.");
  }
  return url;
}

/** Slack, Teams or generic, from the host name. */
export function detectTarget(url: URL): NotifyTarget {
  const host = url.hostname.toLowerCase();
  if (host === "hooks.slack.com" || host.endsWith(".slack.com")) return "slack";
  if (
    host.endsWith(".webhook.office.com") ||
    host.endsWith(".logic.azure.com") ||
    host.endsWith(".powerplatform.com") ||
    host.endsWith(".powerautomate.com")
  )
    return "teams";
  return "generic";
}

export interface SendResult {
  ok: boolean;
  status?: number;
  /** A short reason, safe to print: never includes the URL. */
  error?: string;
}

/**
 * POST the payload. One retry after a short wait on a server error or rate limit. No redirects
 * are followed (a redirect could carry the message to another host). The response body is not
 * returned, because receivers sometimes echo what they were sent.
 */
export async function sendWebhook(
  url: URL,
  payload: unknown,
  opts: { timeoutMs?: number; retryDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify(payload);
  let last: SendResult = { ok: false, error: "not sent" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "sf-preflight" },
        body,
        redirect: "error",
        signal: ctl.signal,
      });
      if (res.ok) return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: `${url.hostname} answered HTTP ${res.status}` };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      last = {
        ok: false,
        error: aborted ? `${url.hostname} did not answer in time` : `could not reach ${url.hostname}`,
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));
  }
  return last;
}

/** Check that parsed JSON is an analysis result before building an alert from it. */
export function readResult(value: unknown): AnalysisResult {
  const r = value as Partial<AnalysisResult> | null;
  const risk = r?.summary?.risk;
  if (
    r?.schemaVersion !== 1 ||
    !(risk === "high" || risk === "medium" || risk === "low") ||
    !Array.isArray(r.findings) ||
    !Array.isArray(r.changes) ||
    !r.summary?.findingsBySeverity ||
    typeof r.summary.findingsBySeverity !== "object"
  ) {
    throw new Error("Not an sf-preflight JSON report (expected the output of `preflight analyze --json-out`).");
  }
  return r as AnalysisResult;
}
