// SPDX-License-Identifier: Apache-2.0
// Times sf-preflight on a Salesforce DX project and prints a Markdown table.
//
//   npm run build
//   node scripts/bench.mjs <project-dir> [--runs 3] [--file <path to a .cls in the project>] [--json]
//
// Each measurement runs in a fresh Node process with its own empty or warm parse cache in a
// temporary directory, so your real cache is never read or written. The "after editing one
// class" scenario appends a comment to one Apex file and puts the original back afterwards.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const json = args.includes("--json") && args.splice(args.indexOf("--json"), 1).length > 0;
const runs = Math.max(1, Number.parseInt(flag("--runs") ?? "3", 10) || 3);
const fileArg = flag("--file");
const project = args[0] ? path.resolve(args[0]) : undefined;
if (!project) {
  console.error("Usage: node scripts/bench.mjs <project-dir> [--runs 3] [--file <.cls file>] [--json]");
  process.exit(1);
}
const core = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "core", "index.js");

// Only Apex in the project's package directories counts as source.
let roots = ["."];
try {
  const pj = JSON.parse(readFileSync(path.join(project, "sfdx-project.json"), "utf8"));
  roots = (pj.packageDirectories ?? []).map((d) => d.path);
} catch {
  // no sfdx-project.json: use the whole folder
}
const classes = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!["node_modules", ".git", ".sfdx", "dist"].includes(e.name)) walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".cls")) classes.push(path.join(dir, e.name));
  }
};
for (const r of roots) walk(path.join(project, r));
if (!classes.length) {
  console.error(`No Apex classes found under ${project}.`);
  process.exit(1);
}
const target = fileArg ? path.resolve(fileArg) : classes.sort()[0];

// Runs inside the measured process: analyze one changed file, report time and peak memory.
const child = `
  const t = process.hrtime.bigint();
  const { analyzeChange } = await import(${JSON.stringify(core)});
  const { result } = analyzeChange({ projectDir: ${JSON.stringify(project)}, files: [${JSON.stringify(target)}] });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(JSON.stringify({ ms, rssMb: process.resourceUsage().maxRSS / 1024, findings: result.findings.length }));
`;

function measure(cacheDir, env) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    encoding: "utf8",
    env: { ...process.env, PREFLIGHT_CACHE_DIR: cacheDir, ...env },
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error(`Benchmark run failed:\n${r.stderr.slice(-2000)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const threads = Math.min(os.availableParallelism(), 8);
const tmp = mkdtempSync(path.join(os.tmpdir(), "preflight-bench-"));
const original = readFileSync(target, "utf8");
const rows = [];

// Put the edited file back however the script ends (Ctrl+C, a timeout's SIGTERM, an error).
const cleanup = () => {
  try {
    writeFileSync(target, original);
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

function scenario(label, env, prepare) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const dir = path.join(tmp, `${label}-${i}`.replace(/\W+/g, "-"));
    prepare?.(dir);
    const t0 = Date.now();
    samples.push(measure(dir, env));
    console.error(`  ${label} (${i + 1}/${runs}): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  rows.push({
    label,
    seconds: median(samples.map((s) => s.ms)) / 1000,
    rssMb: median(samples.map((s) => s.rssMb)),
    findings: samples[0].findings,
  });
}

try {
  // Cold: an empty cache every run.
  scenario("First run, 1 thread", { PREFLIGHT_JOBS: "1" });
  scenario(`First run, ${threads} threads`, { PREFLIGHT_JOBS: String(threads) });
  // Warm: fill the cache once, then measure runs against it (each run on its own copy of the cache).
  const warm = path.join(tmp, "warm");
  measure(warm, {});
  const copyWarm = (dir) => {
    spawnSync("cp", ["-R", warm, dir]);
  };
  scenario("Repeat run (cached)", {}, copyWarm);
  writeFileSync(target, `${original}\n// preflight-bench edit\n`);
  scenario("Repeat run after editing one class", {}, copyWarm);
} finally {
  cleanup();
}

const info = {
  project: path.basename(project),
  apexClasses: classes.length,
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.availableParallelism(),
  node: process.version,
  runs,
};
if (json) {
  console.log(JSON.stringify({ info, rows }, null, 2));
} else {
  console.log(
    `${info.project}: ${info.apexClasses} Apex classes. ${info.cpu}, ${info.cores} cores, Node ${info.node}, median of ${runs}.\n`,
  );
  console.log("| Scenario | Time | Peak memory |\n|---|---:|---:|");
  for (const r of rows) console.log(`| ${r.label} | ${r.seconds.toFixed(1)} s | ${Math.round(r.rssMb)} MB |`);
}
