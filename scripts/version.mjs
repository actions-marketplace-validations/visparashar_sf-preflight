// SPDX-License-Identifier: Apache-2.0
// Keeps every place that carries the release version in step.
//
//   node scripts/version.mjs 0.9.0     set the version everywhere and date the changelog
//   node scripts/version.mjs --check   fail if the places disagree (runs in `npm run lint`)
//
// One version covers the CLI, the agent skill, the Claude Code plugin, the evidence doc and the
// sf plugin (which depends on the CLI of the same minor version). The VS Code extension has its
// own version and its own tags.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const read = (f) => readFileSync(f, "utf8");
const json = (f) => JSON.parse(read(f));
const writeJson = (f, o) => writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
const SEMVER = /^\d+\.\d+\.\d+$/;

/** [file, how to read the version in it] */
function found() {
  const root = json("package.json");
  const plugin = json("sf-plugin/package.json");
  const claude = json(".claude-plugin/plugin.json");
  return [
    ["package.json", root.version],
    ["sf-plugin/package.json", plugin.version],
    ["sf-plugin/package.json (sf-preflight dependency)", plugin.dependencies["sf-preflight"].replace(/^\^/, "")],
    [".claude-plugin/plugin.json", claude.version],
    [".claude-plugin/plugin.json (pinned npx)", /sf-preflight@(\d+\.\d+\.\d+)/.exec(JSON.stringify(claude))?.[1]],
    ["skills/sf-preflight/SKILL.md", /^\s*version:\s*"([^"]+)"/m.exec(read("skills/sf-preflight/SKILL.md"))?.[1]],
    ["docs/EVIDENCE.md", /Tool \| sf-preflight (\d+\.\d+\.\d+)/.exec(read("docs/EVIDENCE.md"))?.[1]],
  ];
}

const arg = process.argv[2];
if (arg === "--check") {
  const rows = found();
  const want = rows[0][1];
  const bad = rows.filter(([, v]) => v !== want);
  if (bad.length) {
    console.error(`Version mismatch (package.json says ${want}):`);
    for (const [f, v] of bad) console.error(`  ${f}: ${v ?? "not found"}`);
    console.error("Run: node scripts/version.mjs <version>");
    process.exit(1);
  }
  const log = read("CHANGELOG.md");
  if (!log.includes(`## [${want}]`)) {
    console.error(`CHANGELOG.md has no "## [${want}]" section.`);
    process.exit(1);
  }
  console.log(`Versions agree: ${want}`);
} else if (arg && SEMVER.test(arg)) {
  const v = arg;
  const root = json("package.json");
  root.version = v;
  writeJson("package.json", root);
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { stdio: "ignore" });

  const plugin = json("sf-plugin/package.json");
  plugin.version = v;
  plugin.dependencies["sf-preflight"] = `^${v}`;
  writeJson("sf-plugin/package.json", plugin);

  let claude = read(".claude-plugin/plugin.json");
  claude = claude.replace(/("version":\s*")[^"]+/, `$1${v}`).replace(/sf-preflight@\d+\.\d+\.\d+/, `sf-preflight@${v}`);
  writeFileSync(".claude-plugin/plugin.json", claude);

  writeFileSync(
    "skills/sf-preflight/SKILL.md",
    read("skills/sf-preflight/SKILL.md").replace(/^(\s*version:\s*")[^"]+/m, `$1${v}`),
  );
  writeFileSync("docs/EVIDENCE.md", read("docs/EVIDENCE.md").replace(/(Tool \| sf-preflight )\d+\.\d+\.\d+/, `$1${v}`));

  // Date the Unreleased notes and fix the compare links, unless this version is already there.
  let log = read("CHANGELOG.md");
  if (!log.includes(`## [${v}]`)) {
    const prev = /^\[Unreleased\]: .*\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD$/m.exec(log)?.[1];
    const today = new Date().toISOString().slice(0, 10);
    log = log.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${v}] - ${today}\n`);
    if (prev) {
      const repo = "https://github.com/visparashar/sf-preflight";
      log = log.replace(
        /^\[Unreleased\]: .*$/m,
        `[Unreleased]: ${repo}/compare/v${v}...HEAD\n[${v}]: ${repo}/compare/v${prev}...v${v}`,
      );
    }
    writeFileSync("CHANGELOG.md", log);
  }
  console.log(`Set version ${v}. Review the CHANGELOG, then commit.`);
} else {
  console.error("Usage: node scripts/version.mjs <x.y.z> | --check");
  process.exit(1);
}
