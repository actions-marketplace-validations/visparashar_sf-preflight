// SPDX-License-Identifier: Apache-2.0
import { preflightCommand } from "../../command.js";

export default preflightCommand({
  cli: "explain",
  summary: "Show what runs, in order, when records of an object are saved.",
  examples: ["<%= config.bin %> <%= command.id %> Opportunity"],
  org: false,
  hasFormat: false,
  flags: {},
});
