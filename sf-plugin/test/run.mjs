// SPDX-License-Identifier: Apache-2.0
// Runs the plugin's commands the way `sf` would, without needing sf installed.
import { execute } from "@oclif/core";

await execute({ dir: new URL("../package.json", import.meta.url).href, args: process.argv.slice(2) });
