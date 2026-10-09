// SPDX-License-Identifier: Apache-2.0
import { Command, Flags } from "@oclif/core";
import type { FlagInput } from "@oclif/core/interfaces";
import { runCli, translate } from "./passthrough.js";

export interface PreflightCommandSpec {
  /** The preflight CLI command this wraps, e.g. `analyze`. */
  cli: string;
  summary: string;
  description?: string;
  examples: string[];
  /** The CLI command has `--format`, so `--json` can map onto it. */
  hasFormat: boolean;
  /** Flags to show in `--help`. All flags of the CLI work, whether listed or not. */
  flags: FlagInput;
  /** The CLI command reads an org, so `--target-org` / `-o` map to its `--org`. */
  org: boolean;
}

const targetOrg = Flags.string({
  char: "o",
  summary: "Org to read from, by username or alias (an `sf org login` org).",
});

const common = {
  project: Flags.string({ char: "p", summary: "SFDX project directory (default: the current directory)." }),
};

export const gitFlags = {
  base: Flags.string({ char: "b", summary: "Git base ref, e.g. origin/main." }),
  head: Flags.string({ summary: "Git head ref (default: the working tree)." }),
  files: Flags.string({ char: "f", summary: "Explicit changed files instead of a git diff.", multiple: true }),
};

/**
 * Builds an `sf preflight <name>` command. The plugin adds no analysis of its own: it passes the
 * command line to the sf-preflight CLI, so the two always agree.
 */
export function preflightCommand(spec: PreflightCommandSpec) {
  return class extends Command {
    static override summary = spec.summary;
    static override description = spec.description;
    static override examples = spec.examples;
    // Flags not listed below are valid too: they are handed to the sf-preflight CLI as they are.
    static override strict = false;
    static override enableJsonFlag = false;
    static override flags = {
      ...common,
      ...(spec.org ? { "target-org": targetOrg } : {}),
      ...spec.flags,
      json: Flags.boolean({ summary: spec.hasFormat ? "Print JSON (same as --format json)." : "Accepted; no effect." }),
    };

    async run(): Promise<void> {
      const code = await runCli(spec.cli, translate(this.argv, { hasFormat: spec.hasFormat, org: spec.org }));
      if (code !== 0) this.exit(code);
    }
  };
}
