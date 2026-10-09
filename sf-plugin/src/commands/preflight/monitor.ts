// SPDX-License-Identifier: Apache-2.0
import { Flags } from "@oclif/core";
import { preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "monitor",
  summary: "Watch an org's Setup Audit Trail for risky changes and alert Slack or Teams.",
  description:
    "Reads the Setup Audit Trail of the target org (read-only; production is fine) and reports validation rules or flows switched off, broad permissions, Apex, sharing and security changes. Set PREFLIGHT_WEBHOOK_URL and use --notify-on to send an alert.",
  examples: [
    "<%= config.bin %> <%= command.id %> --target-org prod --since 24h",
    "<%= config.bin %> <%= command.id %> --target-org prod --since 1h --notify-on high",
  ],
  org: true,
  hasFormat: true,
  flags: {
    since: Flags.string({ summary: "Changes since a duration (1h, 24h, 7d) or a date." }),
    "notify-on": Flags.string({ summary: "Send an alert at this risk or higher.", options: ["medium", "high"] }),
    format: Flags.string({ summary: "Output format.", options: ["md", "json"] }),
  },
});
