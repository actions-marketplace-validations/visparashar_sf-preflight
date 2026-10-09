// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "rollback",
  summary: "Plan a partial rollback of a change: restore or deactivate only the components that need it.",
  description: "Prints the commands; nothing is deployed.",
  examples: ["<%= config.bin %> <%= command.id %> a1b2c3d --target-org my-sandbox"],
  org: true,
  hasFormat: true,
  flags: { format: Flags.string({ summary: "Output format.", options: ["md", "json"] }) },
});
