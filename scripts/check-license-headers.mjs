#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fails when a source file is missing its SPDX license identifier.
// The identifier must appear in the first lines of the file (after a shebang, if any).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const HEADER = "SPDX-License-Identifier: Apache-2.0";
const PATTERNS = ["*.ts", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"];
const EXCLUDE = [/^dist\//, /^coverage\//, /^fixtures\//, /^node_modules\//];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...PATTERNS], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file && existsSync(file) && !EXCLUDE.some((re) => re.test(file)));

const missing = files.filter((file) => {
  const head = readFileSync(file, "utf8").split("\n", 4).join("\n");
  return !head.includes(HEADER);
});

if (missing.length > 0) {
  console.error(`Missing "// ${HEADER}" at the top of:`);
  for (const file of missing) console.error(`  ${file}`);
  console.error("See CONTRIBUTING.md#license-headers.");
  process.exit(1);
}
console.log(`License headers OK (${files.length} files).`);
