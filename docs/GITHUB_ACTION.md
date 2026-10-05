# GitHub Action

> `@v0` always points at the latest 0.x release. Pin an exact tag such as `@v0.1.0` if you
> prefer fully reproducible runs.

Run sf-preflight on every pull request. The action posts the report as a PR comment (updating
the same comment on each push), adds it to the job summary, evaluates the
[quality gate](CONFIG.md#quality-gate) and fails the check when it doesn't pass, uploads the
change's [evidence pack](EVIDENCE.md) as an artifact (optionally signed), and can upload
findings to GitHub code scanning.

## Quick start

```yaml
# .github/workflows/preflight.yml
name: Preflight

on:
  pull_request:
    paths: ["force-app/**", "sfdx-project.json", ".preflight.json"]
  # Re-evaluate the gate when someone approves (or dismisses an approval).
  pull_request_review:
    types: [submitted, dismissed]

permissions:
  contents: read
  pull-requests: write # PR comment, and reading reviews for the gate

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # needed to diff against the base branch and read commit history
      - uses: visparashar/sf-preflight@v0
```

The gate's policy comes from `.preflight.json` (see [CONFIG.md](CONFIG.md)); without one, the
gate fails on high findings, as `fail-on: high` did before. To block merges (and DevOps Center
promotions) on it, make the `preflight` check required in your branch protection rules: see
[PIPELINES.md](PIPELINES.md#devops-center).

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
| `fail-on` | from `.preflight.json`, else `high` | Severity that fails the gate: `low`, `medium`, `high`, or `none` |
| `config` | `.preflight.json` | Policy file: rule overrides, ignores, gate settings ([CONFIG.md](CONFIG.md)) |
| `evidence` | `true` | Write the evidence pack and upload it as a workflow artifact |
| `artifact-name` | `sf-preflight-evidence` | Evidence artifact name (unique per workflow run) |
| `attest` | `false` | Sign the evidence with a GitHub artifact attestation (see below) |
| `comment` | `true` | Post and update a PR comment (needs `pull-requests: write`) |
| `sarif` | `false` | Upload findings to code scanning (needs `security-events: write`) |
| `depth` | `4` | Maximum cascade depth |
| `sfdx-auth-url` | — | Beta: SFDX auth URL (from a secret) of a read-only integration user; adds org context |
| `org` | — | Beta: alias of an org already authorized earlier in the job; adds org context |
| `version` | matches the action ref | sf-preflight npm version to run; `local` builds from the action's source |
| `node-version` | `22` | Node.js version to set up; empty string uses the runner's Node |
| `github-token` | `github.token` | Token for the PR comment and for reading reviews |

## Outputs

| Output | Description |
|---|---|
| `risk` | `low`, `medium` or `high` |
| `high`, `medium` | Number of findings at that severity |
| `ai-assisted-commits` | AI-assisted commits detected in the PR (from co-author trailers and tool markers) |
| `report-markdown`, `report-json`, `report-sarif` | Paths to the generated reports |
| `gate` | `pass` or `fail` |
| `evidence`, `evidence-digest` | Path to the evidence pack and its SHA-256 digest |
| `attestation-url` | Link to the signed attestation, with `attest: true` |

## Approvals

The action reads the pull request's reviews: each reviewer's latest approve or dismiss decision
counts, and the PR author doesn't. On a push (for example after merging), it uses the pull
request the commit came from. Approvals feed the gate's `aiAssistedApprovals` setting and are
recorded in the evidence pack. Add the `pull_request_review` trigger shown above so the check
re-runs when someone approves.

## Signed evidence

With `attest: true`, the evidence pack is signed with a
[GitHub artifact attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)
(Sigstore). Anyone with access to the repository can then check that a given evidence file was
produced by your workflow and not changed since:

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write
  attestations: write
  artifact-metadata: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: visparashar/sf-preflight@v0
    with:
      attest: "true"
```

```bash
gh attestation verify evidence.json --repo <owner>/<repo> \
  --predicate-type https://github.com/visparashar/sf-preflight/evidence/v1
```

Artifact attestations are available for public repositories, and for private ones on GitHub
Enterprise Cloud.

To require a reviewer for AI-assisted changes, use the gate rather than workflow logic:

```json
{ "gate": { "aiAssistedApprovals": 1 } }
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
  summary, approvals and the pass/fail result still work.
- **Several projects in one workflow** need a different `artifact-name` for each run of the
  action.
- The action runs `npx sf-preflight@<version>`. Pin the action to a release tag (for example
  `@v0.1.0`) for fully reproducible runs.
- The checkout must include the base branch history (`fetch-depth: 0`).
