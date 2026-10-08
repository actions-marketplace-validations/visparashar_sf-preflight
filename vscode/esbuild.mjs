// SPDX-License-Identifier: Apache-2.0
// Bundles the extension, its analysis worker and the MCP server, with the sf-preflight library from
// ../src, into dist/. The agent skill is copied alongside so "Install the agent skill" works offline.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
rmSync("dist", { recursive: true, force: true });
const { metafile } = await build({
  metafile: true,
  entryPoints: { extension: "src/extension.ts", worker: "src/worker.ts", "mcp-server": "src/mcp-server.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  // Dependencies written as ES modules (the ANTLR runtime behind the Apex parser) read
  // import.meta.url; in a CommonJS bundle it comes from the bundle's own file name.
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { PREFLIGHT_VERSION: JSON.stringify(version), "import.meta.url": "__import_meta_url" },
  minify: process.argv.includes("--minify"),
  sourcemap: !process.argv.includes("--minify"),
  legalComments: "linked",
});
cpSync("../skills", "dist/skills", { recursive: true });

// The licences of every package bundled into dist/, as their licences require.
const packages = new Map();
for (const input of Object.keys(metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m && !packages.has(m[1])) packages.set(m[1], m[1]);
}
// Licence texts for packages that don't ship one, kept in licenses/ (from each project's repository).
const VENDORED = {
  "@apexdevtools/apex-parser": "licenses/apex-parser.txt",
  antlr4: "licenses/antlr4.txt",
  "@nodable/entities": "licenses/nodable-entities.txt",
};
const notices = [...packages.keys()]
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = file
      ? readFileSync(path.join(dir, file), "utf8").trim()
      : VENDORED[pkg.name]
        ? readFileSync(VENDORED[pkg.name], "utf8").trim()
        : undefined;
    if (!text) throw new Error(`No licence text for ${pkg.name}: add it to licenses/ and VENDORED in esbuild.mjs.`);
    return { name: `${pkg.name}@${pkg.version} (${pkg.license ?? "see text"})`, text };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  "dist/THIRD_PARTY_NOTICES.txt",
  [
    "sf-preflight for VS Code bundles the following packages.",
    "",
    ...notices.flatMap((n) => [`${"=".repeat(78)}`, n.name, `${"=".repeat(78)}`, n.text, ""]),
  ].join("\n"),
);
cpSync("../NOTICE", "dist/NOTICE");
if (!existsSync("dist/THIRD_PARTY_NOTICES.txt")) throw new Error("notices not written");
console.log(`Built the extension with sf-preflight ${version}.`);
