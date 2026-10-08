# Contributing to sf-preflight

Thanks for your interest in making Salesforce changes safer to ship! This project welcomes
contributions of all sizes: bug reports, false-positive reports, docs, new metadata parsers
and new analysis rules.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). How the project
is run and how decisions are made is described in [GOVERNANCE.md](GOVERNANCE.md). Have a
question rather than a change? See [SUPPORT.md](SUPPORT.md).

## Ways to contribute

- **Report a bug or a wrong finding.** Use the issue templates. For false positives or missed
  findings, a minimal SFDX snippet (anonymised) that reproduces it is the most useful thing you
  can send.
- **Propose a feature.** Open a feature request first for anything larger than a small fix so
  we can agree on the approach before you invest time.
- **Pick up an issue.** Issues labelled `good first issue` and `help wanted` are ready to work on.
  Comment on the issue so others know you're on it.
- **Improve the docs.** README, architecture notes and examples are all fair game.
- **Review pull requests and triage issues.** Reproducing a reported finding on your own
  metadata, or confirming that a fix works, is a real contribution.

## Development setup

Requirements: Node.js **22.13+** and git.

```bash
git clone https://github.com/visparashar/sf-preflight.git
cd sf-preflight
npm install
npm run check     # lint + typecheck + tests
npm run build
node dist/cli.js analyze --project fixtures/sample-org --base HEAD
```

| Script | What it does |
|---|---|
| `npm run lint` | Biome lint + format check, and the license-header check |
| `npm run format` | Apply Biome formatting and safe fixes |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest unit and fixture tests |
| `npm run build` | Compile to `dist/` |

## Project layout

```
src/core/parsers/     one parser per metadata type (flows, Apex, fields, …)
src/core/project.ts   finds and parses every metadata file in an SFDX project
src/core/graph.ts     who writes what, who calls whom
src/core/orderOfExecution.ts   the simplified Salesforce save procedure
src/core/analyze.ts   roots → cascade → findings → suggested tests
src/core/report/      Markdown, JSON and SARIF output
src/core/testgen/     Apex test generation (preflight tests)
src/core/org/         read-only org context via the sf CLI (--org)
src/cli.ts            command-line entry point
src/mcp.ts            MCP server (stdio) for coding agents
skills/sf-preflight/  the agent skill (Agent Skills format)
.claude-plugin/, hooks/   the Claude Code plugin and marketplace
vscode/               the VS Code extension (its own package; bundles src/)
action.yml            GitHub Action (composite)
fixtures/sample-org/  SFDX project with deliberate failure modes
scripts/              repository maintenance scripts (license-header check)
test/                 vitest tests
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together and how to add
a parser or a rule.

## Making a change

1. Fork the repo and create a branch from `main` (`fix/flow-loop-resolution`, `feat/sarif-output`, …).
2. Write a test first when fixing a bug — ideally a fixture snippet that reproduces it.
3. Keep changes focused; one logical change per pull request.
4. Run `npm run check` before pushing. CI runs the same checks on Node 22 and 24, plus CodeQL
   and a [DCO](#developer-certificate-of-origin) sign-off check.
5. Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
6. Open a pull request and fill in the template.

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/) where practical:

```
feat(flows): resolve inputReference through assignment collections
fix(apex): ignore DML keywords inside SOQL FOR UPDATE
docs: explain cascade depth option
```

### AI-assisted contributions

AI coding tools are welcome here — helping review AI-authored changes is what this project is
for. If a tool wrote a meaningful part of your change:

- say so in the pull request, and keep the tool's commit trailer (for example
  `Co-Authored-By:`) so preflight's own AI-assisted commit detection sees it;
- read and understand every line before you open the pull request — you are accountable for it,
  as for any other contribution;
- don't let a tool invent fixture metadata that wouldn't deploy, or paste in code you don't have
  the right to contribute.

### License headers

Every TypeScript file in `src/`, `test/` and `scripts/` starts with an SPDX identifier (after the
shebang, if any):

```ts
// SPDX-License-Identifier: Apache-2.0
```

`npm run lint` checks for it.

### Adding to the fixture org

`fixtures/sample-org` is shared by many tests. Prefer adding *new* components over changing
existing ones, and update the expectations in `test/analyze.test.ts` if counts change. Every
component in the fixture should be valid Salesforce metadata that would deploy.

### Rules for findings

A finding must be **deterministic** and **explainable**: it names the metadata it came from and
the path that produced it. No network calls and no LLM calls in `src/core`. If a heuristic can
be wrong, say so in the finding detail or lower its severity.

## Developer Certificate of Origin

All contributions are made under the [Apache License 2.0](LICENSE). By submitting a pull request
you certify that you wrote the code or otherwise have the right to submit it under that license
([Developer Certificate of Origin](https://developercertificate.org/)). Please sign off your
commits:

```bash
git commit -s -m "fix(apex): …"
```

A **DCO** check runs on every pull request and fails if a commit is missing a `Signed-off-by:`
line that matches its author. To fix the commits on your branch:

```bash
git rebase --signoff origin/main   # adds sign-off to every commit since main
git push --force-with-lease
```

Commits made in the GitHub web editor need the "Sign off and commit" option. Bot commits (such as
Dependabot's) are exempt.

## Issue triage

New issues get the `triage` label. A maintainer reproduces or clarifies them, then replaces it
with labels such as `bug`, `analysis-accuracy`, `enhancement`, `documentation`,
`good first issue` or `help wanted`. Pull requests that change behavior users must adapt to are
labelled `breaking-change`; labels also decide where a pull request appears in the generated
release notes.

## Releasing (maintainers)

`main` is protected, so a release is a small pull request followed by a tag.

1. Create a branch `release/X.Y.Z` from `main`.
2. Move the **Unreleased** changelog entries under `## [X.Y.Z] - YYYY-MM-DD` and update the
   compare links at the bottom.
3. `npm version X.Y.Z --no-git-tag-version` to bump `package.json` and `package-lock.json`.
   Set the same version in `.claude-plugin/plugin.json` (`version` and the `sf-preflight@X.Y.Z`
   MCP argument) and in `skills/sf-preflight/SKILL.md` (`metadata.version`); a test fails until
   they match.
4. Open a pull request, wait for CI and CodeQL, and merge it.
5. Tag the merge commit and push the tag:

   ```bash
   git fetch origin
   git tag -a vX.Y.Z origin/main -m "sf-preflight X.Y.Z"
   git push origin vX.Y.Z
   ```

The **Release** workflow then runs the checks, publishes to npm with provenance, creates the
GitHub release and moves the major tag (`v0`) that the GitHub Action uses. If a run fails
part-way, re-run it from the tag (Actions → Release → Run workflow → choose the tag); it skips
steps that already succeeded.

### The VS Code extension

The extension in `vscode/` has its own version and tags, `extension-vX.Y.Z`, and bundles the
library from `src/` at that commit.

1. Bump `version` in `vscode/package.json` (`npm version X.Y.Z --no-git-tag-version` in
   `vscode/`) and add the release to `vscode/CHANGELOG.md`, in a pull request.
2. After merging, tag and push: `git tag -a extension-vX.Y.Z origin/main -m "sf-preflight for VS Code X.Y.Z"`.

The **Release VS Code extension** workflow builds, tests and packages the `.vsix`, publishes it
to the VS Code Marketplace (secret `VSCE_PAT`, a Personal Access Token for the `visparashar`
publisher) and Open VSX (secret `OVSX_PAT`), and attaches it to a GitHub release. A missing
token skips that registry with a warning. Put both secrets in the `vscode-marketplace`
environment.

To try a build locally: `cd vscode && npm ci && npm run build && npx vsce package --no-dependencies`,
then **Extensions → … → Install from VSIX**.
