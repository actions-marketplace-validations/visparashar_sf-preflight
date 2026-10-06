// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";

/**
 * Minimal, read-only wrapper around the Salesforce CLI (`sf`). sf-preflight never stores
 * credentials: it uses whatever org the user has already authorized with `sf org login`.
 *
 * A runner takes `sf` arguments (without `--json`) and returns the parsed `result` field.
 * Tests inject a fake runner with recorded responses.
 */
export type SfRunner = (args: string[]) => unknown;

export class SfError extends Error {
  constructor(
    message: string,
    /** The error name sf reported, e.g. "FailedValidationError". */
    readonly sfName?: string,
    /** Extra data sf attached to the error, e.g. `{ deployId }`. */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Org aliases/usernames come from users and agents: allow only safe characters. */
export function assertSafeOrg(org: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,254}$/.test(org)) {
    throw new SfError(`Invalid org alias or username: ${JSON.stringify(org)}`);
  }
  return org;
}

/** Quote an argument for cmd.exe (Windows runs `sf.cmd` through a shell). */
function cmdQuote(arg: string): string {
  if (/["%!^]/.test(arg)) throw new SfError(`Unsupported character in sf argument: ${arg}`);
  return `"${arg}"`;
}

export interface SfRunnerOptions {
  timeoutMs?: number;
  /** Working directory; project commands such as `project deploy` must run inside the project. */
  cwd?: string;
}

export function createSfRunner(opts: SfRunnerOptions = {}): SfRunner {
  return (args: string[]) => {
    const fullArgs = [...args, "--json"];
    const windows = process.platform === "win32";
    let stdout: string;
    try {
      stdout = execFileSync(windows ? "sf.cmd" : "sf", windows ? fullArgs.map(cmdQuote) : fullArgs, {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 180_000,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: windows,
        env: { ...process.env, SF_SKIP_NEW_VERSION_CHECK: "true", SF_DISABLE_AUTOUPDATE: "true" },
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string };
      if (e.code === "ENOENT") {
        throw new SfError(
          "Salesforce CLI (`sf`) not found on PATH. Install it from https://developer.salesforce.com/tools/salesforcecli or run without --org.",
        );
      }
      stdout = typeof e.stdout === "string" ? e.stdout : "";
      if (!stdout) throw new SfError(`sf ${args[0] ?? ""} failed: ${e.message}`);
    }
    let parsed: { status?: number; result?: unknown; message?: string; name?: string; data?: unknown };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new SfError(`Unexpected output from sf ${args.slice(0, 2).join(" ")}`);
    }
    // Some commands report their result but exit non-zero (e.g. `agent test run` when a test case
    // errors); errors themselves carry no result.
    if (parsed.status !== 0 && parsed.result !== undefined && parsed.result !== null) return parsed.result;
    if (parsed.status !== 0) {
      throw new SfError(
        parsed.message ?? `sf ${args.slice(0, 2).join(" ")} failed (${parsed.name ?? "error"})`,
        parsed.name,
        parsed.data,
      );
    }
    return parsed.result;
  };
}

export interface QueryRecord {
  [field: string]: unknown;
}

/** Run a SOQL query (optionally against the Tooling API) and return its records. */
export function query(run: SfRunner, org: string, soql: string, tooling = false): QueryRecord[] {
  const args = ["data", "query", "--query", soql, "--target-org", org];
  if (tooling) args.push("--use-tooling-api");
  const result = run(args) as { records?: QueryRecord[] } | undefined;
  return (result?.records ?? []).map(({ attributes: _a, ...r }) => r);
}

/** Read a possibly nested field from a query record, e.g. "SubscriberPackage.Name". */
export function field(record: QueryRecord, path: string): unknown {
  let cur: unknown = record;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** API names interpolated into SOQL must be plain identifiers. */
export function soqlList(names: string[]): string {
  const safe = names.filter((n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(n));
  return safe.map((n) => `'${n}'`).join(", ");
}

/** Like soqlList, for values such as profile names that may contain spaces. */
export function soqlStringList(values: string[]): string {
  const safe = values.filter((v) => /^[\w .()&/-]{1,120}$/.test(v));
  return safe.map((v) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ");
}
