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
export type ParseOutcome = { file: string; value: object } | { file: string; error: string };

if (parentPort) {
  const { port, signal, jobs, objects } = workerData as ParseWorkerData;
  const projectObjects = new Set(objects);
  const results: ParseOutcome[] = [];
  try {
    for (const j of jobs) {
      try {
        results.push({ file: j.file, value: parseApexUnit(j.kind, j.source, j.name, j.file, projectObjects) });
      } catch (err) {
        results.push({ file: j.file, error: (err as Error).message });
      }
    }
    port.postMessage(results);
  } finally {
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
}
