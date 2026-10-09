// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { gitFlags, preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "tests",
  summary: "Generate Apex tests for what a change touches (bulk, recursion, idempotency, swallowed errors).",
  description:
    "Writes test classes to a folder. With --validate and --target-org it runs them in a check-only deployment: nothing is saved in the org. Production orgs are refused unless --allow-production.",
  examples: [
    "<%= config.bin %> <%= command.id %> --base origin/main --dry-run",
    "<%= config.bin %> <%= command.id %> --base origin/main --validate --target-org my-sandbox",
  ],
  org: true,
  hasFormat: true,
  flags: {
    ...gitFlags,
    "dry-run": Flags.boolean({ summary: "Print the summary without writing files." }),
    validate: Flags.boolean({ summary: "Run the tests in the target org with a check-only deployment." }),
    "allow-production": Flags.boolean({ summary: "Allow --validate in a production org." }),
    format: Flags.string({ summary: "Summary format.", options: ["md", "json"] }),
  },
});
