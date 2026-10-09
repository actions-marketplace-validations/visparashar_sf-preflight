// SPDX-License-Identifier: Apache-2.0
import { gitFlags, preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "evidence",
  summary: "Write the evidence pack for a change: what changed, findings, tests, approvals, gate.",
  examples: ["<%= config.bin %> <%= command.id %> --base origin/main --out preflight-evidence.json"],
  org: false,
  hasFormat: false,
  flags: { ...gitFlags },
});
