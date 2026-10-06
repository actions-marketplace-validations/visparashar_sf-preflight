// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git, gitBlob, gitRoot, isShallow } from "./changes.js";
import type { Approval, GateResult } from "./gate.js";
import type { ValidationResult } from "./org/validate.js";
import type { AnalysisResult, ChangeType, ComponentType, Severity, TestKind } from "./types.js";
import { redactEmails } from "./util.js";

/**
 * The evidence pack: one self-contained, verifiable record per change of what changed, who (or
 * what) wrote it, what preflight found, which tests ran and how they did, who approved it, and the
 * quality-gate decision. A SHA-256 digest over its canonical JSON makes tampering detectable; the
 * GitHub Action can also sign it with an artifact attestation.
 */

export const EVIDENCE_PREDICATE_TYPE = "https://github.com/visparashar/sf-preflight/evidence/v1";

export interface EvidenceComponent {
  changeType: ChangeType;
  type: ComponentType;
  name: string;
  file: string;
  /** SHA-256 of the file at the head of the change; null when deleted or unreadable. */
  sha256: string | null;
}

export interface EvidencePack {
  evidenceVersion: 1;
  predicateType: typeof EVIDENCE_PREDICATE_TYPE;
  generatedAt: string;
  tool: { name: "sf-preflight"; version: string };
  repository?: { url?: string; projectPath?: string };
  change: {
    base?: { ref: string; sha?: string };
    head: { ref: string; sha?: string; uncommitted?: boolean };
    /** The pull request, when the pipeline provides it (its head can differ from a CI merge commit). */
    pullRequest?: { number: number; headSha?: string; url?: string };
    authorship?: {
      /** False when the repository is a shallow clone, so commits before its cut-off are missing. */
      complete: boolean;
      commits: number;
      aiAssistedCommits: number;
      tools: string[];
      details: { sha: string; subject: string; author: string; aiTools: string[] }[];
    };
    components: EvidenceComponent[];
  };
  analysis: {
    risk: AnalysisResult["summary"]["risk"];
    findingsBySeverity: Record<Severity, number>;
    findings: { rule: string; severity: Severity; title: string; object?: string; files: string[] }[];
    impactedObjects: string[];
    cycles: number;
    agentActions: { agent: string; topic?: string; action: string; tests: string[] }[];
    warnings: number;
  };
  tests: {
    suggested: number;
    generated?: { method: string; kind: TestKind; title: string }[];
    validation?: {
      org: string;
      status: "passed" | "failed";
      passed: number;
      failed: number;
      setupFailed: number;
      notRun: number;
      componentErrors: number;
      deployId?: string;
    };
  };
  /** Approvals provided to the run (e.g. pull request reviews); absent when unknown. */
  approvals?: Approval[];
  gate: GateResult;
  /** The policy the gate used: file relative to the repository, the ref it was read from, its digest. */
  config?: { file: string; ref?: string; sha256?: string };
  /**
   * SHA-256 over the canonical JSON of every other field. It detects accidental changes; anyone
   * who can edit the file can recompute it, so proof of origin comes from a signature (the GitHub
   * Action's artifact attestation) or a copy of the digest kept elsewhere.
   */
  digest: { algorithm: "sha256"; value: string };
}

/** JSON with object keys sorted at every level, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** "Jane Doe <jane@example.com>" → "Jane Doe". */
function withoutEmail(author: string): string {
  const t = author.trim();
  const lt = t.lastIndexOf("<");
  return lt > 0 && t.endsWith(">") ? t.slice(0, lt).trim() : t;
}

/** The digest an evidence pack should carry; compare with `digest.value` to verify it. */
export function evidenceDigest(pack: Omit<EvidencePack, "digest"> | EvidencePack): string {
  const { digest: _digest, ...rest } = pack as EvidencePack;
  return sha256(canonicalJson(rest));
}

/** Is this an evidence pack whose digest matches its content? */
export function verifyEvidence(pack: unknown): pack is EvidencePack {
  if (typeof pack !== "object" || pack === null || Array.isArray(pack)) return false;
  const p = pack as Partial<EvidencePack>;
  return (
    p.evidenceVersion === 1 &&
    p.predicateType === EVIDENCE_PREDICATE_TYPE &&
    typeof p.digest === "object" &&
    p.digest !== null &&
    p.digest.algorithm === "sha256" &&
    p.digest.value === evidenceDigest(p as EvidencePack)
  );
}

/** Remote URL without credentials (`https://user:token@host/…` → `https://host/…`). */
function cleanUrl(raw: string): string | undefined {
  const url = raw.trim();
  const parse = (u: string) => {
    try {
      const parsed = new URL(u);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return undefined;
    }
  };
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)?.[0];
  if (scheme) {
    // Drop everything up to the last "@": unencoded "/" or "@" in a password would otherwise
    // let part of it through as a host or path.
    const at = url.lastIndexOf("@");
    return parse(at > scheme.length ? scheme + url.slice(at + 1) : url);
  }
  // scp-style "git@github.com:org/repo.git" has no credentials beyond the user name.
  return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url) ? url : undefined;
}

/** Org label from a tests-result file: an alias, never a username. */
const orgName = (org: unknown) =>
  typeof org === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(org) && !org.includes("@") ? org : "target org";

const tryGit = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** What the `preflight tests --format json` output contains that evidence uses. */
export interface TestsResultFile {
  tests?: { method: string; kind: TestKind; title: string }[];
  validation?: ValidationResult;
}

export interface EvidenceOptions {
  result: AnalysisResult;
  gate: GateResult;
  version: string;
  approvals?: Approval[];
  tests?: TestsResultFile;
  pullRequest?: { number: number; headSha?: string; url?: string };
}

export function buildEvidence(opts: EvidenceOptions): EvidencePack {
  const { result } = opts;
  const projectDir = result.projectDir;
  const root = gitRoot(projectDir);
  const headRef = result.head ?? "HEAD";
  const uncommitted =
    !result.head && !!root && !!tryGit(root, ["status", "--porcelain", "--untracked-files=no", "--", projectDir]);

  const projectPath = root ? path.relative(root, projectDir).split(path.sep).join("/") : "";
  // Hash the file's bytes (as `sha256sum` would), from git at the head ref or from disk.
  const digestOf = (file: string, changeType: ChangeType): string | null => {
    if (changeType === "deleted") return null;
    if (result.head) {
      if (!root) return null;
      const bytes = gitBlob(root, result.head, projectPath ? `${projectPath}/${file}` : file);
      return bytes === undefined ? null : sha256(bytes);
    }
    const abs = path.join(projectDir, file);
    return existsSync(abs) ? sha256(readFileSync(abs)) : null;
  };

  const v = opts.tests?.validation;
  const count = (o: string) => (Array.isArray(v?.tests) ? v.tests.filter((t) => t.outcome === o).length : 0);
  const pr = opts.pullRequest;

  const pack: Omit<EvidencePack, "digest"> = {
    evidenceVersion: 1,
    predicateType: EVIDENCE_PREDICATE_TYPE,
    generatedAt: new Date().toISOString(),
    tool: { name: "sf-preflight", version: opts.version },
    repository: root
      ? {
          url: (() => {
            const u = tryGit(root, ["remote", "get-url", "origin"]);
            return u ? cleanUrl(u) : undefined;
          })(),
          projectPath: projectPath || ".",
        }
      : undefined,
    change: {
      base: result.base
        ? {
            ref: result.base,
            sha: root ? tryGit(root, ["rev-parse", "--verify", `${result.base}^{commit}`]) : undefined,
          }
        : undefined,
      head: {
        ref: result.head ?? "working tree",
        sha: root ? tryGit(root, ["rev-parse", "--verify", `${headRef}^{commit}`]) : undefined,
        ...(uncommitted ? { uncommitted: true } : {}),
      },
      pullRequest:
        pr && Number.isInteger(pr.number) && pr.number > 0
          ? {
              number: pr.number,
              headSha: pr.headSha && /^[0-9a-f]{40}$/.test(pr.headSha) ? pr.headSha : undefined,
              url: pr.url && /^https:\/\/[^\s@]+$/.test(pr.url) ? pr.url : undefined,
            }
          : undefined,
      authorship: result.provenance
        ? {
            complete: !result.provenance.shallow && !(root && isShallow(root)),
            commits: result.provenance.commits,
            aiAssistedCommits: result.provenance.aiAssistedCommits,
            tools: result.provenance.tools,
            // Name only: the commit SHA already identifies the author's email in the repository.
            details: result.provenance.details.map((d) => ({
              sha: d.sha,
              subject: redactEmails(d.subject),
              author: withoutEmail(d.author),
              aiTools: d.aiTools,
            })),
          }
        : undefined,
      components: result.changes.map((c) => ({
        changeType: c.changeType,
        type: c.component.type,
        name: c.component.name,
        file: c.component.file,
        sha256: digestOf(c.component.file, c.changeType),
      })),
    },
    analysis: {
      risk: result.summary.risk,
      findingsBySeverity: result.summary.findingsBySeverity,
      findings: result.findings.map((f) => ({
        rule: f.rule,
        severity: f.severity,
        title: f.title,
        object: f.object,
        files: f.files,
      })),
      impactedObjects: result.impactedObjects,
      cycles: result.cycles.length,
      agentActions: result.agents.map((a) => ({ agent: a.agent, topic: a.topic, action: a.action, tests: a.tests })),
      warnings: result.warnings.length,
    },
    tests: {
      suggested: result.suggestedTests.length,
      generated: opts.tests?.tests?.map((t) => ({ method: t.method, kind: t.kind, title: t.title })),
      validation: v
        ? {
            org: orgName(v.org),
            status: v.status,
            passed: count("pass"),
            failed: count("fail"),
            setupFailed: count("setup failed"),
            notRun: count("not run"),
            componentErrors: Array.isArray(v.componentErrors) ? v.componentErrors.length : 0,
            deployId: v.deployId,
          }
        : undefined,
    },
    approvals: opts.approvals,
    gate: opts.gate,
    config: result.config
      ? {
          file: path.posix.normalize(path.posix.join(projectPath || ".", result.config.file)),
          ref: result.config.ref,
          sha256: result.config.sha256,
        }
      : undefined,
  };
  return { ...pack, digest: { algorithm: "sha256", value: evidenceDigest(pack) } };
}

const short = (sha?: string) => (sha ? ` (${sha.slice(0, 7)})` : "");
const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Human summary of an evidence pack. */
export function evidenceToMarkdown(e: EvidencePack): string {
  const a = e.change.authorship;
  const v = e.tests.validation;
  const failed = e.gate.checks.filter((c) => c.status === "fail").length;
  const rows: [string, string][] = [
    [
      "Change",
      `${e.change.base ? `\`${e.change.base.ref}\`${short(e.change.base.sha)} → ` : ""}\`${e.change.head.ref}\`${short(e.change.head.sha)}${e.change.head.uncommitted ? ", with uncommitted changes" : ""}`,
    ],
    ["Components", `${e.change.components.length} changed`],
    [
      "Authorship",
      a
        ? `${a.commits} commit(s), ${a.aiAssistedCommits} AI-assisted${a.tools.length ? ` (${a.tools.join(", ")})` : ""}${a.complete ? "" : "; shallow clone, so earlier commits may be missing (check out with fetch-depth: 0)"}`
        : "not from a commit range",
    ],
    [
      "Risk",
      `${e.analysis.risk} (${e.analysis.findingsBySeverity.high} high, ${e.analysis.findingsBySeverity.medium} medium)`,
    ],
    [
      "Quality gate",
      `${e.gate.status === "pass" ? "✅ passed" : `❌ failed (${failed} of ${e.gate.checks.length} checks)`}`,
    ],
    [
      "Tests",
      v
        ? `${e.tests.generated?.length ?? v.passed + v.failed + v.setupFailed + v.notRun} generated; ${v.passed} passed, ${v.failed} failed${v.setupFailed ? `, ${v.setupFailed} setup failed` : ""} in ${v.org}`
        : e.tests.generated
          ? `${e.tests.generated.length} generated, not run`
          : `${e.tests.suggested} suggested`,
    ],
    [
      "Approvals",
      e.approvals ? (e.approvals.length ? e.approvals.map((x) => x.reviewer).join(", ") : "none") : "not provided",
    ],
    ["Policy", e.config ? `\`${e.config.file}\`${e.config.ref ? ` at \`${e.config.ref}\`` : ""}` : "defaults"],
    ["Tool", `sf-preflight ${e.tool.version}`],
    ["Digest", `\`sha256:${e.digest.value}\``],
  ];
  return [
    "## Change evidence",
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, val]) => `| ${k} | ${cell(val)} |`),
    "",
    `Verify the digest with \`preflight evidence --verify <file>\`.`,
  ].join("\n");
}
