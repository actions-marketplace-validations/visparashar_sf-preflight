// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "agents",
  summary: "List Agentforce agents, or explain what one agent's actions call, save and need.",
  examples: ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> Sales_Agent"],
  org: false,
  hasFormat: true,
  flags: { format: Flags.string({ summary: "Output format.", options: ["md", "json"] }) },
});
