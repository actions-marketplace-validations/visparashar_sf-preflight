// SPDX-License-Identifier: Apache-2.0
import type { EvidencePack } from "../../../src/core/evidence.js";
import {
  Checklist,
  CopyButton,
  Facts,
  FileRef,
  Icon,
  type IndexItem,
  Section,
  SectionIndex,
  Sev,
} from "../components.js";
import { formatDate, githubRepo, plural, riskWord, SEVERITIES, safeHref, shortSha } from "../lib/format.js";
import type { EvidenceDoc } from "../lib/load.js";
import { evidenceToMarkdown } from "../lib/markdown.js";

function headText(e: EvidencePack): string {
  const h = e.change.head;
  const sha = shortSha(h.sha);
  return `${h.ref}${sha && sha !== h.ref ? ` (${sha})` : ""}${h.uncommitted ? ", with uncommitted changes" : ""}`;
}

function Link({ href, children }: { href?: string; children: string }) {
  const safe = safeHref(href);
  return safe ? (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    children
  );
}

function Verdict({ doc }: { doc: EvidenceDoc }) {
  const e = doc.evidence;
  const d = doc.digest;
  const tone = d.matches ? "ok" : "high";
  const word = d.matches ? "Intact" : d.recorded ? "Changed" : "Unverified";
  const written = formatDate(e.generatedAt);
  const sentence = d.matches
    ? `The digest matches: nothing in this evidence pack has changed since sf-preflight ${e.tool?.version ?? ""} wrote it${written ? ` on ${written}` : ""}.`
    : d.recorded
      ? "The digest doesn't match: the file was edited or damaged after it was written. Don't rely on what it says."
      : "This evidence pack has no SHA-256 digest, so there's no way to tell whether it was changed.";
  const repo = githubRepo(e.repository?.url);
  const attest = `gh attestation verify ${/\s/.test(doc.file) ? `"${doc.file}"` : doc.file} ${repo ? `--repo ${repo}` : "--owner <owner>"} --predicate-type ${e.predicateType}`;
  const pr = e.change.pullRequest;

  return (
    <header class="verdict">
      <div>
        <div class={`word tone-${tone}`}>{word}</div>
        <p class="sentence">{sentence}</p>
        <Facts
          className="facts"
          items={[
            ["Change", e.change.base ? `${e.change.base.ref} to ${headText(e)}` : headText(e)],
            ["Pull request", pr ? <Link href={pr.url}>{`#${pr.number}`}</Link> : undefined],
            [
              "Repository",
              e.repository?.url ? <Link href={e.repository.url}>{repo ?? e.repository.url}</Link> : undefined,
            ],
            ["Project", e.repository?.projectPath || undefined],
            ["Risk", riskWord(e.analysis.risk)],
            ["File", doc.origin ? `${doc.name} from ${doc.origin}` : doc.name],
          ]}
        />
        <div class="tools">
          <CopyButton text={() => evidenceToMarkdown(e)} label="Copy as Markdown" />
          <button type="button" class="btn" onClick={() => window.print()}>
            <Icon name="print" size={16} />
            <span class="label">Print</span>
          </button>
        </div>
        {d.matches && (
          <div class="verify">
            <p>
              A matching digest shows the file is intact, not who wrote it. When the GitHub Action signed it, check that
              it came from your pipeline:
            </p>
            <div class="cmd">
              <code>{attest}</code>
              <CopyButton text={() => attest} label="Copy" className="btn quiet" />
            </div>
          </div>
        )}
        {doc.newer && (
          <p class="notice">
            A newer sf-preflight wrote this evidence pack. Parts this viewer doesn't know yet aren't shown.
          </p>
        )}
      </div>
      <Checklist
        gate={e.gate}
        foot={
          e.config ? (
            <>
              Policy <code>{e.config.file}</code>
              {e.config.ref ? <> from {e.config.ref}</> : null}
            </>
          ) : (
            "Policy: sf-preflight defaults"
          )
        }
      />
    </header>
  );
}

export function EvidenceView({ doc }: { doc: EvidenceDoc }) {
  const e = doc.evidence;
  const a = e.analysis;
  const t = e.tests;
  const auth = e.change.authorship;
  const findings = a.findings ?? [];
  const index: IndexItem[] = [
    { id: "components", label: "Components", count: e.change.components.length },
    { id: "findings", label: "Findings", count: findings.length },
    { id: "tests", label: "Tests" },
    ...(auth ? [{ id: "authorship", label: "Authorship" }] : []),
    { id: "approvals", label: "Approvals", count: e.approvals?.length },
    { id: "record", label: "Record" },
  ];

  return (
    <main id="main" class="doc">
      <Verdict doc={doc} />
      <div class="body">
        <SectionIndex items={index} />
        <div class="sections">
          <Section
            id="components"
            title="Components"
            count={e.change.components.length}
            intro="What changed, with the SHA-256 of each file as it was at the head of the change."
          >
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Change</th>
                    <th>Component</th>
                    <th>Type</th>
                    <th>File</th>
                    <th>SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {e.change.components.map((c) => (
                    <tr key={c.file}>
                      <td class={`change-type ${c.changeType}`}>{c.changeType}</td>
                      <td>
                        <code>{c.name}</code>
                      </td>
                      <td class="kind">{c.type}</td>
                      <td>
                        <FileRef file={c.file} />
                      </td>
                      <td>
                        {c.sha256 ? (
                          <code title={c.sha256}>{c.sha256.slice(0, 12)}</code>
                        ) : (
                          <span class="muted">{c.changeType === "deleted" ? "Deleted" : "Unreadable"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="findings" title="Findings" count={findings.length}>
            <Facts
              items={[
                [
                  "By severity",
                  SEVERITIES.filter((s) => a.findingsBySeverity?.[s])
                    .map((s) => `${a.findingsBySeverity[s]} ${s}`)
                    .join(", ") || "None",
                ],
                ["Impacted objects", a.impactedObjects?.length ? a.impactedObjects.join(", ") : undefined],
                ["Recursion cycles", a.cycles ? String(a.cycles) : undefined],
                ["Warnings", a.warnings ? String(a.warnings) : undefined],
              ]}
            />
            {findings.length > 0 && (
              <ul class="findings" style={{ marginTop: "20px" }}>
                {findings.map((f, i) => (
                  <li key={`${f.rule}-${i}`} class={`finding tone-${f.severity}`}>
                    <span class="bar" aria-hidden="true" />
                    <div>
                      <div class="title">{f.title}</div>
                      <div class="meta">
                        <Sev severity={f.severity} />
                        <code>{f.rule}</code>
                        {f.object && <span>{f.object}</span>}
                        {f.files[0] && <FileRef file={f.files[0]} />}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(a.agentActions ?? []).length > 0 && (
              <div class="group" style={{ marginTop: "28px" }}>
                <h3>Agentforce actions affected</h3>
                <ul class="plain-list">
                  {a.agentActions.map((x) => (
                    <li key={`${x.agent}.${x.action}`}>
                      {x.agent}
                      {x.topic ? ` › ${x.topic}` : ""} › {x.action}:{" "}
                      {x.tests.length ? (
                        `covered by ${x.tests.join(", ")}`
                      ) : (
                        <span class="fail">no Testing Center test</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <Section id="tests" title="Tests">
            <Facts
              items={[
                ["Suggested", plural(t.suggested, "test")],
                ["Generated", t.generated ? plural(t.generated.length, "Apex test method") : "Not recorded"],
                [
                  "Sandbox run",
                  t.validation ? (
                    <span class={t.validation.status === "passed" ? "pass" : "fail"}>
                      {t.validation.status === "passed" ? "Passed" : "Failed"} in {t.validation.org}:{" "}
                      {t.validation.passed} passed, {t.validation.failed} failed
                      {t.validation.setupFailed ? `, ${t.validation.setupFailed} failed in setup` : ""}
                      {t.validation.notRun ? `, ${t.validation.notRun} not run` : ""}
                      {t.validation.componentErrors
                        ? `, ${plural(t.validation.componentErrors, "component error")}`
                        : ""}
                    </span>
                  ) : (
                    "Not run"
                  ),
                ],
                [
                  "Testing Center",
                  t.agentTests ? (
                    <span class={t.agentTests.status === "passed" ? "pass" : "fail"}>
                      {t.agentTests.status === "passed" ? "Passed" : "Failed"} in {t.agentTests.org}
                    </span>
                  ) : (
                    "Not run"
                  ),
                ],
              ]}
            />
            {t.generated && t.generated.length > 0 && (
              <div class="table-wrap" style={{ marginTop: "20px" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Kind</th>
                      <th>Tests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.generated.map((g) => (
                      <tr key={g.method}>
                        <td>
                          <code>{g.method}</code>
                        </td>
                        <td class="kind">{g.kind}</td>
                        <td>{g.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {t.agentTests && t.agentTests.runs.length > 0 && (
              <div class="table-wrap" style={{ marginTop: "20px" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Testing Center test</th>
                      <th>Agent</th>
                      <th>Result</th>
                      <th class="num">Passed</th>
                      <th class="num">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.agentTests.runs.map((r) => (
                      <tr key={r.test}>
                        <td>
                          <code>{r.test}</code>
                        </td>
                        <td>{r.agent}</td>
                        <td>{r.status}</td>
                        <td class="num">{r.passed}</td>
                        <td class="num">{r.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {auth && (
            <Section id="authorship" title="Authorship" count={auth.commits}>
              <Facts
                items={[
                  ["AI-assisted", `${auth.aiAssistedCommits} of ${plural(auth.commits, "commit")}`],
                  ["Tools", auth.tools.length ? auth.tools.join(", ") : undefined],
                  ["History", auth.complete ? "Complete" : "Shallow clone: earlier commits are missing"],
                ]}
              />
              {auth.details.length > 0 && (
                <div class="table-wrap" style={{ marginTop: "20px" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Commit</th>
                        <th>Subject</th>
                        <th>Author</th>
                        <th>AI tools</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auth.details.map((c) => (
                        <tr key={c.sha}>
                          <td>
                            <code>{shortSha(c.sha)}</code>
                          </td>
                          <td>{c.subject}</td>
                          <td>{c.author}</td>
                          <td>{c.aiTools.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}

          <Section id="approvals" title="Approvals" count={e.approvals?.length}>
            {e.approvals === undefined ? (
              <p class="empty-note">
                No approvals were given to this run. The GitHub Action records the pull request's reviews; elsewhere,
                pass them with <code>--approvals</code>.
              </p>
            ) : e.approvals.length === 0 ? (
              <p class="empty-note">Nobody had approved the change when this was written.</p>
            ) : (
              <ul class="plain-list">
                {e.approvals.map((ap) => (
                  <li key={ap.reviewer}>
                    {ap.reviewer}
                    {ap.submittedAt && <span class="muted"> on {formatDate(ap.submittedAt)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="record" title="Record" intro="How this evidence pack identifies itself, and its digests.">
            <Facts
              items={[
                ["Written by", e.tool ? `${e.tool.name} ${e.tool.version}` : undefined],
                ["Written", formatDate(e.generatedAt)],
                ["Format", <code key="p">{e.predicateType}</code>],
                ["Recorded digest", doc.digest.recorded ? <code>sha256:{doc.digest.recorded}</code> : "None"],
                [
                  "Digest of the content",
                  <span key="c" class={doc.digest.matches ? "pass" : "fail"}>
                    <code>sha256:{doc.digest.computed}</code>
                  </span>,
                ],
                ["Policy digest", e.config?.sha256 ? <code>sha256:{e.config.sha256}</code> : undefined],
              ]}
            />
            <p class="verify">
              The digest is SHA-256 over the pack's canonical JSON, computed here in your browser. It's the same check
              as <code>preflight evidence --verify</code>.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}
