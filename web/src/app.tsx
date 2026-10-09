// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Icon, Mark } from "./components.js";
import type { Theme } from "./graph.js";
import { checkLink } from "./lib/links.js";
import { type Doc, type Loaded, loadFiles, loadText, loadUrl, type Problem } from "./lib/load.js";
import { EvidenceView } from "./views/evidence.js";
import { ConfirmLink, Landing, Problems, type SampleKind } from "./views/landing.js";
import { ReportView } from "./views/report.js";

const THEME_KEY = "sf-preflight-viewer:theme";
const SAMPLE_NAME: Record<SampleKind, string> = { report: "Sample report", evidence: "Sample evidence pack" };

function storedTheme(): Theme | undefined {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The theme in use: the one chosen here, else the system's. */
function useTheme(): [Theme, () => void] {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const [chosen, setChosen] = useState<Theme | undefined>(storedTheme);
  const [system, setSystem] = useState<Theme>(media.matches ? "light" : "dark");
  useEffect(() => {
    const on = () => setSystem(media.matches ? "light" : "dark");
    media.addEventListener("change", on);
    return () => media.removeEventListener("change", on);
  }, []);
  const theme = chosen ?? system;
  useEffect(() => {
    if (chosen) document.documentElement.dataset.theme = chosen;
    else delete document.documentElement.dataset.theme;
  }, [chosen]);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setChosen(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered; the choice still applies for this visit.
    }
  };
  return [theme, toggle];
}

function setQuery(params: Record<string, string> | undefined) {
  const url = new URL(window.location.href);
  url.search = params ? new URLSearchParams(params).toString() : "";
  window.history.replaceState(null, "", url);
}

function dotColor(d: Doc): string {
  if (d.kind === "evidence") return d.digest.matches ? "var(--ok)" : "var(--high)";
  return `var(--${d.report.summary.risk})`;
}

export function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [active, setActive] = useState<string>();
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** A link from the address bar (?url=), opened only once the person confirms it. */
  const [pending, setPending] = useState<URL>();
  const [theme, toggleTheme] = useTheme();
  const picker = useRef<HTMLInputElement>(null);

  const open = useCallback(async (loading: Promise<Loaded>, query?: Record<string, string>) => {
    setBusy(true);
    let result: Loaded;
    try {
      result = await loading;
    } catch {
      result = { docs: [], problems: [{ name: "File", message: "It couldn't be read." }] };
    }
    setBusy(false);
    setProblems(result.problems);
    if (result.docs.length) {
      setDocs((d) => [...d, ...result.docs]);
      setActive(result.docs[0]!.id);
      setQuery(query);
      window.scrollTo({ top: 0 });
    }
  }, []);

  const openSample = useCallback(
    (kind: SampleKind) => open(loadUrl(`samples/${kind}.json`, SAMPLE_NAME[kind]), { sample: kind }),
    [open],
  );

  // Links can open a sample (?sample=report) or a file on another site (?url=https://…). A file on
  // another site is only fetched once the person has seen where it comes from and chosen to open it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sample = params.get("sample");
    const url = params.get("url");
    if (sample === "report" || sample === "evidence") void openSample(sample);
    else if (url) {
      const checked = checkLink(url, window.location.href);
      if ("url" in checked) setPending(checked.url);
      else {
        setProblems([{ name: url, message: checked.reason }]);
        setQuery(undefined);
      }
    }
  }, []);

  // Drop files anywhere; paste JSON anywhere outside a text field.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void open(loadFiles(files));
    };
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text?.startsWith("{")) {
        e.preventDefault();
        void open(loadText("Pasted JSON", text));
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, [open]);

  const current = docs.find((d) => d.id === active) ?? docs[docs.length - 1];
  useEffect(() => {
    document.title = current ? `${current.name} – sf-preflight viewer` : "sf-preflight viewer";
  }, [current?.id]);

  const close = (id: string) => {
    const i = docs.findIndex((d) => d.id === id);
    const rest = docs.filter((d) => d.id !== id);
    setDocs(rest);
    if (id === current?.id) setActive(rest[Math.min(i, rest.length - 1)]?.id);
    if (!rest.length) setQuery(undefined);
  };

  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <div class="topbar">
        <div class="topbar-inner">
          <a
            class="brand"
            href="./"
            onClick={(e) => {
              if (!docs.length) return;
              e.preventDefault();
              setActive(undefined);
              setDocs([]);
              setProblems([]);
              setQuery(undefined);
            }}
          >
            <Mark />
            sf-preflight <span class="sub">viewer</span>
          </a>
          <div class="tabs" role="tablist" aria-label="Open files">
            {docs.map((d) => (
              <div key={d.id} class="tab" aria-current={d.id === current?.id ? "true" : undefined}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={d.id === current?.id}
                  title={d.origin ? `${d.name} from ${d.origin}` : d.name}
                  onClick={() => {
                    setActive(d.id);
                    window.scrollTo({ top: 0 });
                  }}
                >
                  <span class="dot" style={{ background: dotColor(d) }} aria-hidden="true" />
                  <span class="name">{d.name}</span>
                </button>
                <button type="button" class="close" aria-label={`Close ${d.name}`} onClick={() => close(d.id)}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </div>
          <div class="actions">
            {docs.length > 0 && (
              <button type="button" class="btn quiet" onClick={() => picker.current?.click()}>
                <Icon name="open" size={16} />
                <span class="label">Open files</span>
              </button>
            )}
            <button
              type="button"
              class="btn quiet"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
            </button>
            <a
              class="btn quiet github"
              href="https://github.com/visparashar/sf-preflight"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span class="label">GitHub</span>
              <Icon name="external" size={14} />
            </a>
          </div>
        </div>
      </div>

      <input
        ref={picker}
        type="file"
        accept=".json,.zip,application/json,application/zip"
        multiple
        hidden
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const files = [...(input.files ?? [])];
          input.value = "";
          if (files.length) void open(loadFiles(files));
        }}
      />

      {current ? (
        <>
          {problems.length > 0 && (
            <div class="doc">
              <Problems problems={problems} onDismiss={() => setProblems([])} />
            </div>
          )}
          {current.kind === "report" ? (
            <ReportView key={current.id} doc={current} theme={theme} />
          ) : (
            <EvidenceView key={current.id} doc={current} />
          )}
        </>
      ) : busy && new URLSearchParams(window.location.search).size ? (
        <p class="loading">Opening…</p>
      ) : pending ? (
        <ConfirmLink
          url={pending}
          onOpen={() => {
            const url = pending.href;
            setPending(undefined);
            void open(loadUrl(url), { url });
          }}
          onCancel={() => {
            setPending(undefined);
            setQuery(undefined);
          }}
        />
      ) : (
        <Landing
          problems={problems}
          busy={busy}
          onChoose={() => picker.current?.click()}
          onText={(t) => void open(loadText("Pasted JSON", t))}
          onUrl={(u) => void open(loadUrl(u), { url: u })}
          onSample={(k) => void openSample(k)}
        />
      )}

      <footer class={current ? "doc" : "landing"} style={{ paddingTop: 0, paddingBottom: "40px" }}>
        <div class="foot-note">
          <span>sf-preflight viewer {PREFLIGHT_VERSION}</span>
          <span>Files are read in your browser and never uploaded.</span>
          <a href="THIRD_PARTY_LICENSES.txt">Third-party licences</a>
          <span>Apache License 2.0</span>
        </div>
      </footer>

      {dragging && current && (
        <div class="dropzone-overlay" aria-hidden="true">
          <div>Drop to open</div>
        </div>
      )}
    </>
  );
}
