# GitHub Action

> `@v0` always points at the latest 0.x release. Pin an exact tag such as `@v0.1.0` if you
> prefer fully reproducible runs.

Run sf-preflight on every pull request. The action posts the report as a PR comment (updating
the same comment on each push), adds it to the job summary, can upload findings to GitHub code
scanning, and fails the check when risk crosses your threshold.

## Quick start

```yaml
# .github/workflows/preflight.yml
name: Preflight

on:
  pull_request:
    paths: ["force-app/**", "sfdx-project.json"]

permissions:
  contents: read
  pull-requests: write # PR comment

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # needed to diff against the base branch and read commit history
      - uses: visparashar/sf-preflight@v0
        with:
          fail-on: high
```

## With code scanning

Findings show up as annotations on the changed files and in the repository's Security tab.

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write # SARIF upload

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: visparashar/sf-preflight@v0
    with:
      sarif: "true"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `project` | `.` | SFDX project directory, relative to the repository root |
| `base` | PR base branch, or `HEAD~1` on push | Git base ref to compare against |
| `fail-on` | `high` | Fail when risk is at or above `low`, `medium` or `high`; `none` never fails |
| `comment` | `true` | Post and update a PR comment (needs `pull-requests: write`) |
| `sarif` | `false` | Upload findings to code scanning (needs `security-events: write`) |
| `depth` | `4` | Maximum cascade depth |
| `sfdx-auth-url` | — | Beta: SFDX auth URL (from a secret) of a read-only integration user; adds org context |
| `org` | — | Beta: alias of an org already authorized earlier in the job; adds org context |
| `version` | matches the action ref | sf-preflight npm version to run; `local` builds from the action's source |
| `node-version` | `22` | Node.js version to set up; empty string uses the runner's Node |
| `github-token` | `github.token` | Token for the PR comment |

## Outputs

| Output | Description |
|---|---|
| `risk` | `low`, `medium` or `high` |
| `high`, `medium` | Number of findings at that severity |
| `ai-assisted-commits` | AI-assisted commits detected in the PR (from co-author trailers and tool markers) |
| `report-markdown`, `report-json`, `report-sarif` | Paths to the generated reports |

Example — require an extra reviewer when AI-assisted commits change high-risk metadata:

```yaml
- uses: visparashar/sf-preflight@v0
  id: preflight
  with:
    fail-on: none
- if: steps.preflight.outputs.risk == 'high' && steps.preflight.outputs.ai-assisted-commits != '0'
  run: echo "::warning::High-risk change with AI-assisted commits — request a platform owner review."
```

## Org context (beta)

With org access, the report also shows record volumes for the impacted objects, automation
that runs in the org but isn't in the repo, and how many users hold changed permission sets.
See [ORG_CONTEXT.md](ORG_CONTEXT.md) for exactly what is queried.

1. Create a read-only integration user (ideally in a sandbox that mirrors production) and log
   in as it with the Salesforce CLI.
2. Get its auth URL: `sf org display --target-org <alias> --verbose --json` and copy
   `result.sfdxAuthUrl`. **It grants API access as that user, so treat it like a password.**
3. Save it as a repository secret, for example `PREFLIGHT_SFDX_AUTH_URL`.
4. Pass it to the action:

```yaml
- uses: visparashar/sf-preflight@v0
  with:
    sfdx-auth-url: ${{ secrets.PREFLIGHT_SFDX_AUTH_URL }}
```

The action installs the Salesforce CLI if needed, reads the URL from stdin (never from the
command line), and logs out at the end of the job. Pull requests from forks don't receive
secrets, so they get the offline analysis only.

## Notes

- **Fork PRs** get a read-only token, so the comment step is skipped with a warning; the job
  summary and the pass/fail result still work.
- The action runs `npx sf-preflight@<version>`. Pin the action to a release tag (for example
  `@v0.1.0`) for fully reproducible runs.
- The checkout must include the base branch history (`fetch-depth: 0`).
