// SPDX-License-Identifier: Apache-2.0
/**
 * Reading files into the viewer: JSON files, zips (a GitHub Actions artifact downloads as one), pasted
 * text and URLs. Everything is read in the browser; nothing is sent anywhere.
 */
import { unzipSync } from "fflate";
import type { EvidencePack } from "../../../src/core/evidence.js";
import type { AnalysisResult } from "../../../src/core/types.js";
import { detect } from "./detect.js";
import { checkDigest, type DigestCheck } from "./digest.js";
import { checkLink } from "./links.js";

/** Largest file read, and largest total unpacked from one zip. */
export const MAX_BYTES = 25 * 1024 * 1024;

interface DocBase {
  id: string;
  /** What the tab shows: the file name, or a label such as "Sample report". */
  name: string;
  /** The file's own name, for commands that take it. */
  file: string;
  /** Where it came from, shown beside the name: a host name for URLs. */
  origin?: string;
  /** Made by a newer sf-preflight than the viewer knows: some parts may not show. */
  newer: boolean;
}
export interface ReportDoc extends DocBase {
  kind: "report";
  report: AnalysisResult;
}
export interface EvidenceDoc extends DocBase {
  kind: "evidence";
  evidence: EvidencePack;
  digest: DigestCheck;
}
export type Doc = ReportDoc | EvidenceDoc;

export interface Problem {
  name: string;
  message: string;
}

export interface Loaded {
  docs: Doc[];
  problems: Problem[];
}

let counter = 0;
const nextId = () => `doc-${++counter}`;
const empty = (): Loaded => ({ docs: [], problems: [] });
const merge = (a: Loaded, b: Loaded): Loaded => ({
  docs: [...a.docs, ...b.docs],
  problems: [...a.problems, ...b.problems],
});
const problem = (name: string, message: string): Loaded => ({ docs: [], problems: [{ name, message }] });
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** One JSON text: a report, an evidence pack, or a problem saying why not. */
export async function loadText(name: string, text: string, origin?: string, fileName?: string): Promise<Loaded> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return problem(name, "This isn't valid JSON. Open the report written with --format json, or an evidence pack.");
  }
  const found = detect(json);
  const base = { id: nextId(), name, file: fileName ?? name.split(" › ").pop() ?? name, ...(origin ? { origin } : {}) };
  if (found.kind === "report")
    return { docs: [{ ...base, kind: "report", report: found.report, newer: found.newer }], problems: [] };
  if (found.kind === "evidence") {
    const digest = await checkDigest(json as object);
    return {
      docs: [{ ...base, kind: "evidence", evidence: found.evidence, digest, newer: found.newer }],
      problems: [],
    };
  }
  return problem(name, found.reason);
}

/** The JSON files in a zip, as texts. */
export function jsonInZip(bytes: Uint8Array): { name: string; text: string }[] {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!/\.json$/i.test(f.name) || f.name.startsWith("__MACOSX/")) return false;
      total += f.originalSize;
      if (total > MAX_BYTES) throw new Error(`The JSON files in this zip unpack to more than ${mb(MAX_BYTES)}.`);
      return true;
    },
  });
  const decoder = new TextDecoder();
  return Object.entries(files).map(([name, data]) => ({ name, text: decoder.decode(data) }));
}

async function loadBytes(name: string, bytes: Uint8Array, origin?: string, fileName?: string): Promise<Loaded> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  if (!isZip) return loadText(name, new TextDecoder().decode(bytes), origin, fileName);
  let entries: { name: string; text: string }[];
  try {
    entries = jsonInZip(bytes);
  } catch (e) {
    return problem(
      name,
      e instanceof Error && e.message.startsWith("The JSON") ? e.message : "This zip can't be read.",
    );
  }
  if (!entries.length) return problem(name, "There's no JSON file in this zip.");
  let out = empty();
  for (const entry of entries) out = merge(out, await loadText(`${name} › ${entry.name}`, entry.text, origin));
  return out;
}

export async function loadFiles(files: File[]): Promise<Loaded> {
  let out = empty();
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      out = merge(out, problem(file.name, `This file is larger than ${mb(MAX_BYTES)}.`));
      continue;
    }
    out = merge(out, await loadBytes(file.name, new Uint8Array(await file.arrayBuffer())));
  }
  return out;
}

/** A report or evidence pack from a URL; the server must allow cross-origin reads (CORS). */
export async function loadUrl(raw: string, displayName?: string): Promise<Loaded> {
  const checked = checkLink(raw, window.location.href);
  if ("reason" in checked) return problem(raw, checked.reason);
  const { url } = checked;
  const fileName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? url.host);
  const name = displayName ?? fileName;
  const origin = url.origin === window.location.origin ? undefined : url.host;
  let res: Response;
  try {
    res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    return problem(name, `${url.host} didn't allow the file to be read from here (CORS), or couldn't be reached.`);
  }
  if (!res.ok) return problem(name, `${url.host} answered ${res.status} ${res.statusText}.`.replace(/ \.$/, "."));
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES) return problem(name, `This file is larger than ${mb(MAX_BYTES)}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) return problem(name, `This file is larger than ${mb(MAX_BYTES)}.`);
  return loadBytes(name, bytes, origin, fileName);
}
