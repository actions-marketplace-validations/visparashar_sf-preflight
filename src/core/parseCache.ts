// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseApexUnit } from "./apexUnit.js";
import { parseInParallel } from "./parallelParse.js";
import { analyzeApex, parseApexClass, parseApexTrigger, stripApex } from "./parsers/apex.js";
import { ANALYZER_FINGERPRINT } from "./parsers/apexAst.js";

/**
 * On-disk cache of Apex parse results. Parsing every class dominates the time on a large
 * project (about 28 s for 1,000 classes), and between runs almost no file has changed.
 *
 * Entries are keyed by the file's path and the SHA-256 of its source. The whole cache is
 * dropped when the analyzer's code changes (a fingerprint of its source, plus a manual
 * version) or the project's set of objects changes (Apex analysis uses that set to tell
 * SObjects from other types). It holds analysis facts such as method names and field
 * references, never the source itself. It is local to the user, written with owner-only
 * permissions, and any problem reading or writing it only means a normal, slower run.
 */

const CACHE_VERSION = 1;
const MAX_BYTES = 200 * 1024 * 1024;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FINGERPRINT = sha(
  [ANALYZER_FINGERPRINT, parseApexUnit, analyzeApex, parseApexClass, parseApexTrigger, stripApex]
    .map(String)
    .join("\u0000"),
);

interface Entry {
  /** SHA-256 of the file's source. */
  h: string;
  /** Analysis result, without `stripped`, `name` and `file` (cheap to rebuild, or known). */
  d: unknown;
}

interface CacheFile {
  v: number;
  fp: string;
  objects: string;
  entries: Record<string, Entry>;
}

/** Where caches live: `PREFLIGHT_CACHE_DIR`, else the user's cache directory. */
export function cacheDir(): string {
  const env = process.env.PREFLIGHT_CACHE_DIR;
  if (env) return env;
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "sf-preflight");
}

export class ParseCache {
  private entries = new Map<string, Entry>();
  private readonly used = new Set<string>();
  /** Results parsed ahead of time on worker threads, waiting for their `get`. */
  private readonly ahead = new Map<string, Entry>();
  private dirty = false;
  private readonly file: string;
  readonly objectsHash: string;
  hits = 0;
  misses = 0;

  /** `enabled: false` (or PREFLIGHT_NO_CACHE=1) makes every lookup a miss and writes nothing. */
  constructor(
    projectDir: string,
    projectObjects: Iterable<string>,
    private readonly enabled = process.env.PREFLIGHT_NO_CACHE !== "1",
  ) {
    this.objectsHash = sha([...projectObjects].sort().join("\n"));
    this.file = path.join(cacheDir(), `${sha(path.resolve(projectDir)).slice(0, 24)}.json`);
    if (!enabled) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CacheFile>;
      if (
        raw.v === CACHE_VERSION &&
        raw.fp === FINGERPRINT &&
        raw.objects === this.objectsHash &&
        raw.entries &&
        typeof raw.entries === "object"
      ) {
        for (const [file, e] of Object.entries(raw.entries)) {
          if (e && typeof e.h === "string" && e.d && typeof e.d === "object") this.entries.set(file, e);
        }
      }
    } catch {
      // Missing, unreadable or corrupt: start empty.
    }
  }

  /** The cached result for this file, or the result of `compute`, which is then remembered. */
  get<T extends object>(file: string, source: string, compute: () => T): T {
    if (!this.enabled) return compute();
    const h = sha(source);
    this.used.add(file);
    const hit = this.entries.get(file);
    if (hit && hit.h === h) {
      this.hits++;
      return structuredClone(hit.d) as T;
    }
    const pre = this.ahead.get(file);
    this.ahead.delete(file);
    this.misses++;
    const value = pre && pre.h === h ? (pre.d as T) : compute();
    this.entries.set(file, { h, d: structuredClone(value) });
    this.dirty = true;
    return value;
  }

  /**
   * Parse the files that aren't cached yet on several threads, ahead of the `get` calls that
   * will use them. Does nothing for small sets or when threads are unavailable.
   */
  prefill(
    files: { file: string; kind: "class" | "trigger"; name: string; source: () => string }[],
    projectObjects: Set<string>,
  ): void {
    const jobs = [];
    for (const f of files) {
      let source: string;
      try {
        source = f.source();
      } catch {
        continue; // unreadable: the normal path reports it
      }
      const hit = this.enabled ? this.entries.get(f.file) : undefined;
      if (hit && hit.h === sha(source)) continue;
      jobs.push({ file: f.file, kind: f.kind, name: f.name, source });
    }
    const done = parseInParallel(jobs, projectObjects);
    for (const j of jobs) {
      const d = done.get(j.file);
      if (d) this.ahead.set(j.file, { h: sha(j.source), d });
    }
  }

  /** Write the cache if anything changed. Files no longer in the project are dropped. */
  save(): void {
    if (!this.enabled) return;
    for (const file of this.entries.keys()) {
      if (!this.used.has(file)) {
        this.entries.delete(file);
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const body = JSON.stringify({
        v: CACHE_VERSION,
        fp: FINGERPRINT,
        objects: this.objectsHash,
        entries: Object.fromEntries(this.entries),
      } satisfies CacheFile);
      if (body.length > MAX_BYTES) return;
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
    }
  }
}
