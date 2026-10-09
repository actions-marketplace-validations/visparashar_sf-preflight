# sf-preflight report viewer

A static site that opens sf-preflight's output in the browser, for people who review changes but
don't run the CLI: reviewers, release managers, auditors.

- **Analysis reports** (`preflight analyze --format json`): the risk, the quality gate, findings
  you can filter and search, the blast-radius graph (the same one as the VS Code extension; click a
  node to list its findings), order of execution, the cascade with its recursion cycles, affected
  Agentforce actions, tests to run, changes, references, org context and authorship.
- **Evidence packs** (`preflight evidence`, or the GitHub Action's artifact): the digest checked in
  the browser (the same check as `preflight evidence --verify`), the `gh attestation verify` command
  to prove where it came from, the gate, components with their file digests, findings, tests,
  approvals and authorship.

Open files by dropping them anywhere on the page, choosing them, pasting JSON, or from a link. The
evidence artifact zip downloaded from a GitHub Actions run opens as it is. Several files open as tabs.
**Copy as Markdown** gives the CLI's own Markdown, and **Print** lays the page out for paper or PDF.

Files are read in the browser and never uploaded. The site has no server side, no analytics and no
third-party requests (fonts are self-hosted); the only files it fetches are the samples and the links
you open.

## Links

| Link | Opens |
|---|---|
| `/?sample=report` | The sample report (one field change in [the sample org](../fixtures/sample-org)) |
| `/?sample=evidence` | The sample evidence pack |
| `/?url=https://…/preflight.json` | A report or evidence pack from another site, after the viewer shows where it comes from and you choose to open it. Only https links to public hosts open, and the site must allow cross-origin reads, as `raw.githubusercontent.com` and Gist raw links do. |

## Run it locally

The viewer bundles parts of the library from `../src` and makes its samples with the CLI, so build the
root project first:

```bash
npm ci && npm run build        # in the repository root
cd web
npm ci
npm run dev                    # http://localhost:5173, rebuilds on change
npm run build                  # writes dist/
```

## Deploy

`dist/` is plain static files, so any static host works. Settings for two are in the repository:

**Vercel.** Import the repository and set **Root Directory** to `web`. [`vercel.json`](vercel.json)
sets the install and build commands, the output directory and the security headers.
[Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvisparashar%2Fsf-preflight&root-directory=web&project-name=sf-preflight-viewer)

**Netlify.** Import the repository; [`netlify.toml`](../netlify.toml) at the root sets everything.
[Deploy to Netlify](https://app.netlify.com/start/deploy?repository=https://github.com/visparashar/sf-preflight)

Both rebuild on every push to `main`, so the viewer and its samples follow the CLI.

## How it's built

- [Preact](https://preactjs.com) and [esbuild](https://esbuild.github.io); about 25 KB of script
  compressed. [`build.mjs`](build.mjs) does everything.
- The **Markdown** comes from the library itself (`toMarkdown`, `evidenceToMarkdown`), and the
  **digest** uses the library's `canonicalJson`. The build gives `node:` modules browser stand-ins and
  marks library modules free of side effects, so only those pure functions are bundled, not the parsers.
- The **graph** is the VS Code extension's model ([`vscode/src/graph.ts`](../vscode/src/graph.ts)) and
  renderer ([`vscode/media/graph.js`](../vscode/media/graph.js)), the renderer running in its own frame
  as it does in a webview, with [`graph/host.js`](graph/host.js) standing in for the webview API.
- [`test/web-viewer.test.ts`](../test/web-viewer.test.ts) checks file detection and the digest against
  the library, and CI builds the site and verifies the sample evidence pack with the CLI.
