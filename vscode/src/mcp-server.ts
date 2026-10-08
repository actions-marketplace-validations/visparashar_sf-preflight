// SPDX-License-Identifier: Apache-2.0
/** The sf-preflight MCP server, bundled with the extension: `node mcp-server.js --root <dir>`. */
import { startMcpServer } from "../../src/mcp.js";

declare const PREFLIGHT_VERSION: string;

const i = process.argv.indexOf("--root");
const root = i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : process.cwd();
startMcpServer({ root, version: PREFLIGHT_VERSION }).catch((err: unknown) => {
  process.stderr.write(`sf-preflight: ${(err as Error).message}\n`);
  process.exit(1);
});
