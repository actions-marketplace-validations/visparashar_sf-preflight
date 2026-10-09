// SPDX-License-Identifier: Apache-2.0
import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { GateResult } from "../../src/core/gate.js";
import type { Severity } from "../../src/core/types.js";
import { SEVERITY_LABEL } from "./lib/format.js";

// ---------------------------------------------------------------- icons

const paths = {
  check: "M4 10.5l4 4 8-9",
  cross: "M5 5l10 10M15 5L5 15",
  open: "M10 3v10M5.5 7.5L10 3l4.5 4.5M3 13v3.5h14V13",
  copy: "M7 7h9v10H7zM4 13V3h9",
  print: "M5.5 8V3h9v5M5.5 14H3V8h14v6h-2.5M5.5 11.5h9V17h-9z",
  close: "M6 6l8 8M14 6l-8 8",
  sun: "M10 6.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4",
  moon: "M16 12.5A7 7 0 017.5 4 7 7 0 1016 12.5z",
  shield: "M10 2l6.5 2.5V9c0 4.2-2.8 7.4-6.5 9-3.7-1.6-6.5-4.8-6.5-9V4.5z",
  external: "M11 3h6v6M17 3l-8 8M14 11v6H3V6h6",
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** The project site's mark: a check in a rounded square. */
export function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="6" stroke="var(--line-strong)" stroke-width="1.5" />
      <path d="M7 13.5l4 4 8-9" stroke="var(--ok)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- small pieces

export function Sev({ severity }: { severity: Severity }) {
  return <span class={`sev ${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

/** A project path, breakable after each slash so long paths wrap cleanly. */
export function FileRef({ file, line }: { file: string; line?: number }) {
  const parts = file.split("/");
  return (
    <code class="path">
      {parts.map((p, i) => (
        <Fragment key={`${i}-${p}`}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
      {line ? `:${line}` : ""}
    </code>
  );
}

/** Text from a report, with `backticked` spans shown as code. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return <>{parts.map((p, i) => (i % 2 ? <code key={`${i}`}>{p}</code> : p))}</>;
}

export function CopyButton({
  text,
  label,
  className = "btn",
}: {
  text: () => string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    const value = text();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
  };
  return (
    <button type="button" class={className} onClick={copy} aria-live="polite">
      <Icon name={copied ? "check" : "copy"} size={16} />
      <span class="label">{copied ? "Copied" : label}</span>
    </button>
  );
}

export function Section({
  id,
  title,
  count,
  intro,
  className = "",
  children,
}: {
  id: string;
  title: string;
  count?: number;
  intro?: ComponentChildren;
  className?: string;
  children: ComponentChildren;
}) {
  return (
    <section id={id} class={`section ${className}`} aria-labelledby={`${id}-h`}>
      <div class="head">
        <h2 id={`${id}-h`}>{title}</h2>
        {count !== undefined && <span class="n">{count.toLocaleString()}</span>}
      </div>
      {intro && <p class="intro">{intro}</p>}
      {children}
    </section>
  );
}

/** Label/value pairs. */
export function Facts({
  items,
  className = "kv",
}: {
  items: [string, ComponentChildren | undefined][];
  className?: string;
}) {
  const shown = items.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!shown.length) return null;
  return (
    <dl class={className}>
      {shown.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** The quality gate as the checklist it is. */
export function Checklist({ gate, foot }: { gate: GateResult; foot?: ComponentChildren }) {
  const passed = gate.status === "pass";
  return (
    <div class="checklist">
      <header>
        <h2>Quality gate</h2>
        <span class={`status ${passed ? "pass" : "fail"}`}>{passed ? "Passed" : "Failed"}</span>
      </header>
      <ul>
        {gate.checks.map((c) => (
          <li key={c.id}>
            <span class={`mark ${c.status === "pass" ? "pass" : "fail"}`}>
              <Icon name={c.status === "pass" ? "check" : "cross"} />
              <span class="sr">{c.status === "pass" ? "Passed:" : "Failed:"}</span>
            </span>
            <div>
              <div class="label">{c.label}</div>
              {c.detail && <div class="detail">{c.detail}</div>}
            </div>
          </li>
        ))}
        {!gate.checks.length && (
          <li>
            <span />
            <div class="detail">No checks were configured.</div>
          </li>
        )}
      </ul>
      {foot && <div class="foot">{foot}</div>}
    </div>
  );
}

export interface IndexItem {
  id: string;
  label: string;
  count?: number;
}

/** Section index, marking the section in view. */
export function SectionIndex({ items }: { items: IndexItem[] }) {
  const [current, setCurrent] = useState(items[0]?.id);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = items.find((i) => seen.get(i.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: "-90px 0px -55% 0px" },
    );
    for (const i of items) {
      const el = document.getElementById(i.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items.map((i) => i.id).join()]);
  return (
    <nav class="index" aria-label="Sections">
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} aria-current={current === i.id ? "true" : undefined} onClick={() => setCurrent(i.id)}>
              <span>{i.label}</span>
              {i.count !== undefined && <span class="n">{i.count.toLocaleString()}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
