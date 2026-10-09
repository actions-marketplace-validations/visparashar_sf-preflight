// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { gitFlags, preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "analyze",
  summary: "See what a Salesforce change sets off: flows, triggers, validation rules, roll-ups, permissions.",
  description:
    "Reads the git diff (or the files you name) and follows it through the metadata in your SFDX project. Nothing is deployed and no org is needed. With --target-org, read-only facts from the org (such as active flows) are added.",
  examples: [
    "<%= config.bin %> <%= command.id %> --base origin/main",
    "<%= config.bin %> <%= command.id %> --base origin/main --gate --md-out preflight.md",
    "<%= config.bin %> <%= command.id %> --files force-app/main/default/classes/Foo.cls --json",
  ],
  org: true,
  hasFormat: true,
  flags: {
    ...gitFlags,
    format: Flags.string({ summary: "Output format.", options: ["md", "json", "sarif", "junit"] }),
    gate: Flags.boolean({ summary: "Evaluate the quality gate from .preflight.json; exit 2 when it fails." }),
  },
});
