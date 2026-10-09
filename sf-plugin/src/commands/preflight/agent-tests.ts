// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { gitFlags, preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "agent-tests",
  summary: "Pick the Agentforce Testing Center tests a change affects, and run them in an org.",
  description:
    "Runs tests that already exist in the target org (a sandbox, scratch org or Developer Edition org with the change deployed). Production is refused unless --allow-production.",
  examples: [
    "<%= config.bin %> <%= command.id %> --base origin/main --dry-run",
    "<%= config.bin %> <%= command.id %> --base origin/main --target-org my-sandbox",
  ],
  org: true,
  hasFormat: true,
  flags: {
    ...gitFlags,
    "dry-run": Flags.boolean({ summary: "List the tests that would run, without running them." }),
    "allow-production": Flags.boolean({ summary: "Allow running in a production org." }),
    format: Flags.string({ summary: "Output format.", options: ["md", "json"] }),
  },
});
