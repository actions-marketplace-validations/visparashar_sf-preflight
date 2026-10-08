// SPDX-License-Identifier: Apache-2.0
/**
 * Runs sf-preflight in a worker thread, so a large project never blocks the editor. One job per
 * worker: the extension sends a request and gets back one message.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  analyzeChange,
  generateTests,
  loadProject,
  saveProcedure,
  testsToMarkdown,
  toMarkdown,
} from "../../src/core/index.js";
import type { SaveEvent } from "../../src/core/types.js";

export type WorkerRequest =
  | { kind: "analyze"; projectDir: string; base: string; depth: number }
  | { kind: "tests"; projectDir: string; base: string; depth: number; outDir: string }
  | { kind: "explain"; projectDir: string; object: string; event: SaveEvent }
  | { kind: "objects"; projectDir: string };

/**
 * Refuse to write through a symbolic link (a committed link named preflight-tests, or one of the
 * generated files) to somewhere outside the project.
 */
function assertInside(project: string, target: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`${target} is a symbolic link; refusing to overwrite it.`);
  }
  let dir = path.dirname(target);
  while (!existsSync(dir)) dir = path.dirname(dir);
  const rel = path.relative(project, realpathSync(dir));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${target} leads outside the project; refusing to write it.`);
  }
}

function handle(req: WorkerRequest): unknown {
  switch (req.kind) {
    case "analyze": {
      const { result } = analyzeChange({ projectDir: req.projectDir, base: req.base, maxDepth: req.depth });
      return { result, markdown: toMarkdown(result) };
    }
    case "tests": {
      const { model, result } = analyzeChange({ projectDir: req.projectDir, base: req.base, maxDepth: req.depth });
      const gen = generateTests(model, result);
      const written: string[] = [];
      const project = realpathSync(req.projectDir);
      for (const f of gen.files) {
        const target = path.join(req.outDir, f.path);
        assertInside(project, target);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, f.content);
        written.push(target);
      }
      return { written, markdown: testsToMarkdown(gen) };
    }
    case "explain": {
      const model = loadProject(req.projectDir);
      return { procedure: saveProcedure(model, req.object, req.event) };
    }
    case "objects": {
      const model = loadProject(req.projectDir);
      return { objects: [...model.objects.values()].map((o) => o.name).sort() };
    }
  }
}

try {
  parentPort?.postMessage({ ok: true, value: handle(workerData as WorkerRequest) });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: (err as Error).message });
}
