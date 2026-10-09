// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The worker script exists only in a build (npm run build), so these tests need dist/.
const built = existsSync(path.resolve("dist/core/parseWorker.js"));

// Loaded by a computed path, so type-checking does not need dist/ to exist.
const load = (name: string) => import(pathToFileURL(path.resolve("dist/core", `${name}.js`)).href);

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "preflight-par-"));
  const classes = path.join(work, "force-app", "main", "default", "classes");
  mkdirSync(classes, { recursive: true });
  writeFileSync(path.join(work, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  for (let i = 0; i < 180; i++) {
    writeFileSync(
      path.join(classes, `Gen${i}.cls`),
      `public class Gen${i} { public static void run(List<Account> accts) { for (Account a : accts) { update a; } Gen${(i + 1) % 180}.run(accts); } }\n`,
    );
  }
  // One file that does not parse, to check the fallback path gives the same result in both modes.
  writeFileSync(path.join(classes, "Broken.cls"), "public class Broken { void x( { insert new Contact(); }\n");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const snap = (m: { classes: Map<string, unknown> }) => JSON.stringify([...m.classes.entries()]);

describe.skipIf(!built)("parallel parsing", () => {
  it("gives the same model as parsing on one thread", async () => {
    const { parseInParallel } = (await load("parallelParse")) as typeof import("../src/core/parallelParse.js");
    const { loadProject } = (await load("project")) as typeof import("../src/core/project.js");
    process.env.PREFLIGHT_JOBS = "1";
    const serial = loadProject(work, { cache: false });
    process.env.PREFLIGHT_JOBS = "2";
    const parallel = loadProject(work, { cache: false });
    delete process.env.PREFLIGHT_JOBS;
    expect(parallel.classes.size).toBe(181);
    expect(snap(parallel)).toBe(snap(serial));

    // And the threads really ran: all files came back from the workers.
    const jobs = [...serial.classes.values()].map((c) => ({
      file: c.file,
      kind: "class" as const,
      name: c.name,
      source: `public class ${c.name} { }`,
    }));
    expect(parseInParallel(jobs, [], 2).size).toBe(jobs.length);
  });
});
