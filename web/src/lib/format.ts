// SPDX-License-Identifier: Apache-2.0
import type { AnalysisResult, Severity } from "../../../src/core/types.js";

export const SEVERITIES: Severity[] = ["high", "medium", "low", "info"];

export const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low", info: "Info" };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export const shortSha = (sha?: string) => (sha ? sha.slice(0, 7) : undefined);

/** Only web links are rendered as links; anything else in a file is shown as text. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** "owner/repo" for a GitHub repository URL. */
export function githubRepo(url: string | undefined): string | undefined {
  const m = url && /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : undefined;
}

/** One plain sentence on how far the change reaches. */
export function reachSentence(r: AnalysisResult): string {
  const s = r.summary;
  if (!s.changedComponents) return "No Salesforce metadata changed.";
  const parts = [
    `${plural(s.changedComponents, "changed component")} ${s.changedComponents === 1 ? "reaches" : "reach"} ${plural(s.impactedObjects, "object")}`,
  ];
  if (s.automationsInvolved) parts.push(`through ${plural(s.automationsInvolved, "automation")}`);
  let sentence = `${parts.join(" ")}.`;
  if (s.cycles) sentence += ` The saves loop back in ${plural(s.cycles, "recursion cycle")}.`;
  if (r.agents.length)
    sentence += ` ${plural(r.agents.length, "Agentforce action")} ${r.agents.length === 1 ? "is" : "are"} affected.`;
  return sentence;
}

export function riskWord(risk: AnalysisResult["summary"]["risk"]): string {
  return `${risk[0]!.toUpperCase()}${risk.slice(1)} risk`;
}

/** File name without the metadata suffix: `Tier_Required` for `…/Tier_Required.validationRule-meta.xml`. */
export function fileLabel(file: string): string {
  return (file.split("/").pop() ?? file).replace(/(\.[A-Za-z]+)?-meta\.xml$/, "");
}

export function sentenceCase(s: string): string {
  return s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}
