// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "incidents",
  summary: "Match recent org errors to the recent changes that probably caused them.",
  description: "Reads errors from the target org (read-only; production is fine) and searches git history.",
  examples: ["<%= config.bin %> <%= command.id %> --target-org prod --since 7d"],
  org: true,
  hasFormat: true,
  flags: {
    since: Flags.string({ summary: "Errors since a duration (7d, 24h, 2w) or a date." }),
    format: Flags.string({ summary: "Output format.", options: ["md", "json"] }),
  },
});
