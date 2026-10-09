// SPDX-License-Identifier: Apache-2.0
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import { parseApexUnit } from "./apexUnit.js";

/**
 * Worker thread for parallel parsing (see parallelParse.ts). Parses its share of the files,
 * posts the results on its own port, then signals the waiting main thread through shared memory.
 */
export interface ParseJob {
  file: string;
  kind: "class" | "trigger";
  name: string;
  source: string;
}
export interface ParseWorkerData {
  port: MessagePort;
  signal: Int32Array;
  jobs: ParseJob[];
  objects: string[];
}
/** Slots in the shared `signal` array: workers finished, workers started, files parsed so far. */
export const DONE = 0;
export const STARTED = 1;
export const PROGRESS = 2;

export type ParseOutcome = { file: string; value: object } | { file: string; error: string };

if (parentPort) {
  const { port, signal, jobs, objects } = workerData as ParseWorkerData;
  Atomics.add(signal, STARTED, 1);
  Atomics.notify(signal, STARTED);
  const projectObjects = new Set(objects);
  const results: ParseOutcome[] = [];
  try {
    for (const j of jobs) {
      try {
        results.push({ file: j.file, value: parseApexUnit(j.kind, j.source, j.name, j.file, projectObjects) });
      } catch (err) {
        results.push({ file: j.file, error: (err as Error).message });
      }
      Atomics.add(signal, PROGRESS, 1);
    }
    port.postMessage(results);
  } finally {
    Atomics.add(signal, DONE, 1);
    Atomics.notify(signal, DONE);
  }
}
