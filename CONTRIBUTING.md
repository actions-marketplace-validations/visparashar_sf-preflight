# Contributing to sf-preflight

Thanks for your interest in making Salesforce changes safer to ship! This project welcomes
contributions of all sizes: bug reports, false-positive reports, docs, new metadata parsers
and new analysis rules.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug or a wrong finding.** Use the issue templates. For false positives or missed
  findings, a minimal SFDX snippet (anonymised) that reproduces it is the most useful thing you
  can send.
- **Propose a feature.** Open a feature request first for anything larger than a small fix so
  we can agree on the approach before you invest time.
- **Pick up an issue.** Issues labelled `good first issue` and `help wanted` are ready to work on.
  Comment on the issue so others know you're on it.
- **Improve the docs.** README, architecture notes and examples are all fair game.

## Development setup

Requirements: Node.js **22.12+** and git.

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
| `npm run lint` | Biome lint + format check |
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
src/core/report/      Markdown and JSON output
src/cli.ts            command-line entry point
src/mcp.ts            MCP server (stdio) for coding agents
action.yml            GitHub Action (composite)
fixtures/sample-org/  SFDX project with deliberate failure modes
test/                 vitest tests
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together and how to add
a parser or a rule.

## Making a change

1. Fork the repo and create a branch from `main` (`fix/flow-loop-resolution`, `feat/sarif-output`, …).
2. Write a test first when fixing a bug — ideally a fixture snippet that reproduces it.
3. Keep changes focused; one logical change per pull request.
4. Run `npm run check` before pushing. CI runs the same checks on Node 22 and 24.
5. Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
6. Open a pull request and fill in the template.

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/) where practical:

```
feat(flows): resolve inputReference through assignment collections
fix(apex): ignore DML keywords inside SOQL FOR UPDATE
docs: explain cascade depth option
```

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

## Releasing (maintainers)

1. Move the **Unreleased** changelog entries under a new version heading.
2. `npm version <patch|minor|major>` — this updates `package.json` and creates a `vX.Y.Z` tag.
3. `git push --follow-tags`. The release workflow builds, tests, publishes to npm with
   provenance and creates the GitHub release.
