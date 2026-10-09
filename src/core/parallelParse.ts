// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { ParseJob, ParseOutcome, ParseWorkerData } from "./parseWorker.js";

// Slots of the shared signal array (same values as in parseWorker.ts, which cannot be imported
// here at run time because importing it would start parsing).
const DONE = 0;
const STARTED = 1;
const PROGRESS = 2;

/** Below this many uncached files, starting workers costs more than it saves. */
export const PARALLEL_MIN_FILES = 150;
const MAX_JOBS = 8;
/** Workers that have not started after this long are given up on. */
const START_MS = 20_000;
/** Give up when no file has finished parsing for this long. */
const STALL_MS = 60_000;

/** Number of parse threads: PREFLIGHT_JOBS, else the CPU count (at most 8). 1 means no threads. */
export function parseJobs(): number {
  const env = Number.parseInt(process.env.PREFLIGHT_JOBS ?? "", 10);
  const n = Number.isFinite(env) && env > 0 ? env : availableParallelism();
  return Math.max(1, Math.min(n, MAX_JOBS));
}

/**
 * The worker script next to this module: `parseWorker.js` from the TypeScript build, or
 * `parse-worker.js` from the extension bundle. Absent when running from TypeScript sources.
 */
function workerScript(): string | undefined {
  for (const name of ["./parseWorker.js", "./parse-worker.js"]) {
    const file = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Parse files on several threads and wait for them, synchronously, so callers keep their
 * synchronous API: the calling thread sleeps on shared memory (Atomics.wait) and reads the
 * results from message ports afterwards. Returns what finished; anything missing (no worker
 * script, a crashed worker, the deadline) is left for the caller to parse itself.
 */
export function parseInParallel(
  jobs: ParseJob[],
  projectObjects: Iterable<string>,
  threads = parseJobs(),
): Map<string, object> {
  const out = new Map<string, object>();
  const script = workerScript();
  if (!script || threads < 2 || jobs.length < PARALLEL_MIN_FILES) return out;

  // Biggest first onto the least-loaded thread, so the threads finish together.
  const n = Math.min(threads, jobs.length);
  const shares: ParseJob[][] = Array.from({ length: n }, () => []);
  const load = new Array<number>(n).fill(0);
  for (const j of [...jobs].sort((a, b) => b.source.length - a.source.length)) {
    const i = load.indexOf(Math.min(...load));
    shares[i]?.push(j);
    load[i] = (load[i] ?? 0) + j.source.length + 1;
  }

  const signal = new Int32Array(new SharedArrayBuffer(12));
  const objects = [...projectObjects];
  const workers: Worker[] = [];
  const channels: MessageChannel[] = [];
  try {
    for (const share of shares) {
      const ch = new MessageChannel();
      channels.push(ch);
      const data: ParseWorkerData = { port: ch.port2, signal, jobs: share, objects };
      // execArgv: the parent's flags (-e, --input-type, -r, ...) may be refused in a worker.
      const w = new Worker(script, { workerData: data, transferList: [ch.port2], execArgv: [] });
      w.on("error", () => {}); // a crashed worker just leaves its files for the caller
      workers.push(w);
    }
    // A worker that fails to start (or crashes) reports through events, which this thread cannot
    // handle while it sleeps, so watch the shared counters instead of waiting for a message.
    const startBy = Date.now() + START_MS;
    for (let started = Atomics.load(signal, STARTED); started < n; started = Atomics.load(signal, STARTED)) {
      if (Date.now() > startBy) return out; // the finally block stops the workers
      Atomics.wait(signal, STARTED, started, 200);
    }
    let lastProgress = Atomics.load(signal, PROGRESS);
    let lastChange = Date.now();
    for (let done = Atomics.load(signal, DONE); done < n; done = Atomics.load(signal, DONE)) {
      Atomics.wait(signal, DONE, done, 250);
      const progress = Atomics.load(signal, PROGRESS);
      if (progress !== lastProgress) {
        lastProgress = progress;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > STALL_MS) {
        return out; // stalled: the caller parses the rest itself
      }
    }
    for (const ch of channels) {
      for (let msg = receiveMessageOnPort(ch.port1); msg; msg = receiveMessageOnPort(ch.port1)) {
        for (const r of msg.message as ParseOutcome[]) if ("value" in r) out.set(r.file, r.value);
      }
    }
  } finally {
    for (const w of workers) void w.terminate();
    for (const ch of channels) ch.port1.close();
  }
  return out;
}
