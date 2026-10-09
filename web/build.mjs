// SPDX-License-Identifier: Apache-2.0
// Builds the report viewer into dist/: the app (with the parts of the sf-preflight library it uses,
// from ../src), the blast-radius graph page (the VS Code extension's renderer, from ../vscode/media),
// sample files made by the CLI from the bundled sample org, and the licences of what is bundled.
//
//   node build.mjs           production build
//   node build.mjs --serve   rebuild on change and serve on http://localhost:5173
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(here, "dist");
const serve = process.argv.includes("--serve");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/**
 * The library is written for Node. The viewer only uses its pure parts (Markdown reports and the
 * graph model), so: `node:path` gets a small browser version, other Node built-ins become empty
 * modules (nothing the viewer calls touches them), and library modules are marked free of side
 * effects so the parsers and org code they import but the viewer never calls are left out.
 */
const browserLibrary = {
  name: "browser-library",
  setup(b) {
    b.onResolve({ filter: /^node:path$/ }, () => ({ path: path.join(here, "src/shims/path.ts") }));
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: "node-builtin" }));
    b.onLoad({ filter: /.*/, namespace: "node-builtin" }, () => ({ contents: "module.exports = {};", loader: "js" }));
    b.onResolve({ filter: /\.js$/ }, async (a) => {
      if (a.pluginData?.inner || !a.importer.startsWith(path.join(root, "src", "core"))) return undefined;
      const r = await b.resolve(a.path, {
        kind: a.kind,
        importer: a.importer,
        resolveDir: a.resolveDir,
        pluginData: { inner: true },
      });
      return r.errors.length ? undefined : { path: r.path, sideEffects: false };
    });
  },
};

const hash = (data) => createHash("sha256").update(data).digest("hex").slice(0, 10);

/** Sample report and evidence pack: one field change in the bundled sample org. */
function writeSamples() {
  const cli = path.join(root, "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("The samples are made with the CLI: run `npm ci && npm run build` in the repository root first.");
  }
  const out = path.join(dist, "samples");
  mkdirSync(out, { recursive: true });
  const project = path.join(root, "fixtures", "sample-org");
  const field = "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";
  const common = ["--project", project, "--files", path.join(project, field)];
  const run = (args) => {
    try {
      return execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      // Exit code 2 means the quality gate failed, which the sample shows on purpose.
      if (e.status === 2) return e.stdout;
      throw new Error(`preflight ${args[0]} failed: ${e.stderr?.toString() || e.message}`);
    }
  };

  const report = JSON.parse(run(["analyze", ...common, "--gate", "--fail-on", "high", "--format", "json"]).toString());
  report.projectDir = "fixtures/sample-org"; // not the build machine's path
  writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const approvals = path.join(here, "samples", "approvals.json");
  run(["evidence", ...common, "--approvals", approvals, "--out", path.join(out, "evidence.json")]);
}

/** Output files of the bundle, relative to dist/. */
const outputsOf = (metafile) => Object.keys(metafile.outputs).map((f) => path.relative(dist, path.resolve(here, f)));

/**
 * The graph page: the VS Code extension's renderer and its stylesheet, unchanged, with a host
 * script standing in for VS Code and the viewer's theme (bundled, with its fonts, as graph-theme).
 */
function writeGraphPage(metafile) {
  const out = path.join(dist, "graph");
  mkdirSync(out, { recursive: true });
  const theme = outputsOf(metafile).find((f) => /^assets\/graph-theme-.*\.css$/.test(f));
  if (!theme) throw new Error("The graph theme is missing from the bundle.");
  let html = readFileSync(path.join(here, "graph", "graph.html"), "utf8").replaceAll("{{theme.css}}", `../${theme}`);
  const files = {
    "graph.css": path.join(root, "vscode", "media", "graph.css"),
    "host.js": path.join(here, "graph", "host.js"),
    "graph.js": path.join(root, "vscode", "media", "graph.js"),
  };
  for (const [name, src] of Object.entries(files)) {
    const data = readFileSync(src);
    const hashed = name.replace(/\.(\w+)$/, `-${hash(data)}.$1`);
    writeFileSync(path.join(out, hashed), data);
    html = html.replaceAll(`{{${name}}}`, hashed);
  }
  writeFileSync(path.join(out, "index.html"), html);
}

/** The licences of every package bundled into the app, as their licences require. */
function writeLicences(metafile) {
  const packages = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (m && bytesInOutput > 0) packages.add(m[1]);
    }
  }
  const parts = [`sf-preflight viewer ${version}: third-party software bundled into this site.\n`];
  for (const dir of [...packages].sort()) {
    const abs = path.resolve(here, dir);
    const pkg = JSON.parse(readFileSync(path.join(abs, "package.json"), "utf8"));
    const licence = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license"]
      .map((f) => path.join(abs, f))
      .find((f) => existsSync(f));
    if (!licence) throw new Error(`No licence file in ${dir}`);
    parts.push(
      `${"-".repeat(72)}\n${pkg.name} ${pkg.version} (${pkg.license})\n\n${readFileSync(licence, "utf8").trim()}\n`,
    );
  }
  writeFileSync(path.join(dist, "THIRD_PARTY_LICENSES.txt"), parts.join("\n"));
}

/** index.html with the hashed app files filled in. */
function writeIndex(metafile) {
  const outputs = outputsOf(metafile);
  const js = outputs.find((f) => /^assets\/app-.*\.js$/.test(f));
  const css = outputs.find((f) => /^assets\/app-.*\.css$/.test(f));
  if (!js || !css) throw new Error("The app bundle is missing.");
  const html = readFileSync(path.join(here, "index.html"), "utf8")
    .replaceAll("{{app.js}}", js)
    .replaceAll("{{app.css}}", css)
    .replaceAll("{{version}}", version);
  writeFileSync(path.join(dist, "index.html"), html);
}

const options = {
  entryPoints: { app: path.join(here, "src", "main.tsx"), "graph-theme": path.join(here, "graph", "theme.css") },
  outdir: path.join(dist, "assets"),
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "chrome111", "firefox114", "safari16.4"],
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".woff2": "file", ".woff": "file" },
  define: { PREFLIGHT_VERSION: JSON.stringify(version) },
  plugins: [browserLibrary],
  metafile: true,
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  legalComments: "none",
  logLevel: "warning",
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeSamples();
cpSync(path.join(here, "public"), dist, { recursive: true });

if (serve) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      ...options.plugins,
      {
        name: "pages",
        setup(b) {
          b.onEnd((r) => {
            if (!r.metafile) return;
            writeIndex(r.metafile);
            writeGraphPage(r.metafile);
          });
        },
      },
    ],
  });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 5173 });
  console.log(`Viewer at http://localhost:${port}`);
} else {
  const { metafile } = await esbuild.build(options);
  writeIndex(metafile);
  writeGraphPage(metafile);
  writeLicences(metafile);
  const size = Object.values(metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(`Built dist/ (${Math.round(size / 1024)} KB of app assets).`);
}
