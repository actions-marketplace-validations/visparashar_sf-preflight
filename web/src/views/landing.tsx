// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "preact/hooks";
import { CopyButton, Icon } from "../components.js";
import type { Problem } from "../lib/load.js";

export type SampleKind = "report" | "evidence";

const REPORT_CMD = "npx sf-preflight analyze --base origin/main --format json --out preflight.json";
const EVIDENCE_CMD = "npx sf-preflight evidence --base origin/main --out evidence.json";

export function Problems({ problems, onDismiss }: { problems: Problem[]; onDismiss?: () => void }) {
  if (!problems.length) return null;
  return (
    <div class="problems" role="alert">
      {problems.map((p, i) => (
        <div key={`${p.name}-${i}`} class="problem">
          <b>{p.name}</b>: {p.message}
        </div>
      ))}
      {onDismiss && (
        <div>
          <button type="button" class="linkish" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Asks before opening a file from another site that a link (?url=) points to. */
export function ConfirmLink({ url, onOpen, onCancel }: { url: URL; onOpen: () => void; onCancel: () => void }) {
  return (
    <main id="main" class="landing">
      <h1>Open this file?</h1>
      <p class="lede">
        The link you followed opens a file from <b>{url.host}</b>. Open it only if you trust whoever sent the link: a
        file can say anything, and an evidence pack's digest shows it's intact, not who made it.
      </p>
      <div class="cmd" style={{ marginTop: "28px", maxWidth: "52em" }}>
        <code>{url.href}</code>
      </div>
      <div class="samples" style={{ marginTop: "24px" }}>
        <button type="button" class="btn primary" onClick={onOpen}>
          <Icon name="open" size={16} />
          Open file
        </button>
        <button type="button" class="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </main>
  );
}

export function Landing({
  problems,
  busy,
  onChoose,
  onText,
  onUrl,
  onSample,
}: {
  problems: Problem[];
  busy: boolean;
  onChoose: () => void;
  onText: (text: string) => void;
  onUrl: (url: string) => void;
  onSample: (kind: SampleKind) => void;
}) {
  const [over, setOver] = useState(false);
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const depth = useRef(0);

  return (
    <main id="main" class="landing">
      <h1>Open a preflight report</h1>
      <p class="lede">
        See what a Salesforce change sets off, or check that an evidence pack is intact, without installing anything.
        Files are read in your browser and never uploaded.
      </p>

      <section
        class={`drop${over ? " over" : ""}`}
        aria-label="Open a file"
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setOver(true);
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setOver(false);
        }}
        onDrop={() => {
          // The page opens dropped files wherever they land.
          depth.current = 0;
          setOver(false);
        }}
      >
        <div>
          <strong>{busy ? "Opening…" : "Drop a report or evidence pack here"}</strong>
          <p class="hint">
            <code>preflight.json</code>, <code>evidence.json</code>, or the evidence artifact zip from a GitHub Actions
            run. You can open several at once.
          </p>
        </div>
        <div class="buttons">
          <button type="button" class="btn primary" onClick={onChoose} disabled={busy}>
            <Icon name="open" size={16} />
            Choose files
          </button>
        </div>
      </section>

      <div class="samples">
        <span>No file to hand?</span>
        <button type="button" class="linkish" onClick={() => onSample("report")}>
          Open the sample report
        </button>
        <button type="button" class="linkish" onClick={() => onSample("evidence")}>
          Open the sample evidence pack
        </button>
      </div>

      <Problems problems={problems} />

      <div class="more-ways">
        <details>
          <summary>Paste JSON</summary>
          <textarea
            aria-label="Report or evidence pack JSON"
            placeholder='{ "schemaVersion": 1, … }'
            value={pasted}
            onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)}
          />
          <div style={{ marginTop: "10px" }}>
            <button type="button" class="btn" disabled={!pasted.trim()} onClick={() => onText(pasted)}>
              Open pasted JSON
            </button>
          </div>
        </details>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) onUrl(url.trim());
          }}
        >
          <label for="url">Open from a link</label>
          <div class="field-row">
            <input
              id="url"
              type="url"
              inputMode="url"
              placeholder="https://…/preflight.json"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
            <button type="submit" class="btn" disabled={!url.trim()}>
              Open
            </button>
          </div>
          <p class="muted" style={{ fontSize: "13px", marginTop: "8px" }}>
            The site must allow cross-origin reads, as raw GitHub and Gist links do.
          </p>
        </form>
      </div>

      <div class="where">
        <div>
          <h2>Analysis report</h2>
          <p>
            Everything one change sets off: findings, the blast radius, order of execution, affected Agentforce actions
            and the tests to run. In VS Code, run <b>sf-preflight: Open report in the web viewer</b> from the{" "}
            <a
              href="https://marketplace.visualstudio.com/items?itemName=visparashar.sf-preflight-vscode"
              target="_blank"
              rel="noopener noreferrer"
            >
              extension
            </a>
            . Or write it as JSON from the root of an SFDX project:
          </p>
          <div class="cmd">
            <code>{REPORT_CMD}</code>
            <CopyButton text={() => REPORT_CMD} label="Copy" className="btn quiet" />
          </div>
        </div>
        <div>
          <h2>Evidence pack</h2>
          <p>
            The record of a change for audits: what changed, who wrote it, findings, tests, approvals and the gate
            decision, with a digest that shows if it was edited. The GitHub Action uploads one per run; or write it
            yourself:
          </p>
          <div class="cmd">
            <code>{EVIDENCE_CMD}</code>
            <CopyButton text={() => EVIDENCE_CMD} label="Copy" className="btn quiet" />
          </div>
        </div>
      </div>
    </main>
  );
}
