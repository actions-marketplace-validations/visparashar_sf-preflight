// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The sf-preflight CLI this plugin runs: `SF_PREFLIGHT_CLI` (for development), else the dependency. */
export function cliPath(): string {
  const override = process.env.SF_PREFLIGHT_CLI;
  if (override) return path.resolve(override);
  const require = createRequire(import.meta.url);
  const pkgFile = require.resolve("sf-preflight/package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { bin?: Record<string, string> };
  const bin = pkg.bin?.preflight;
  if (!bin) throw new Error("The sf-preflight package has no `preflight` binary.");
  const file = path.join(path.dirname(pkgFile), bin);
  if (!existsSync(file)) throw new Error(`sf-preflight is installed but ${file} is missing.`);
  return file;
}

/**
 * Turn `sf` conventions into the preflight CLI's own flags.
 *  - `--target-org X` / `-o X` / `--target-org=X` become `--org X`, for commands that read an org
 *    (there `-o` is the org, as in every sf command; the CLI's own `-o` is spelled `--out`).
 *  - `--json` becomes `--format json` for commands that have formats, and is dropped for the rest.
 *
 * Everything else is passed through untouched and in order, so every flag of the CLI works.
 */
export function translate(argv: string[], opts: { hasFormat: boolean; org: boolean }): string[] {
  const out: string[] = [];
  let json = false;
  let formatGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      out.push(...argv.slice(i));
      break;
    }
    if (a === "--json") {
      json = true;
    } else if (opts.org && (a === "--target-org" || a === "-o")) {
      out.push("--org");
    } else if (opts.org && a.startsWith("--target-org=")) {
      out.push("--org", a.slice("--target-org=".length));
    } else if (opts.org && a.startsWith("-o=")) {
      out.push("--org", a.slice(3));
    } else {
      if (a === "--format" || a.startsWith("--format=")) formatGiven = true;
      out.push(a);
    }
  }
  if (json && opts.hasFormat && !formatGiven) out.push("--format", "json");
  return out;
}

/** Run the preflight CLI with the terminal attached, and resolve with its exit code. */
export function runCli(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), command, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
