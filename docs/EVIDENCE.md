# Evidence pack

Every change can produce an **evidence pack**: one JSON document that records what changed, who
or what wrote it, what preflight found, which tests ran and how they did, who approved it, and
the quality-gate decision. It's meant for change records, audits and release sign-off, especially
when part of the change was written by an AI tool.

```bash
preflight evidence --base origin/main --head HEAD --out evidence.json
```

This prints a summary and writes the JSON. `preflight analyze --evidence-out evidence.json`
writes the same file as part of a normal run, and the [GitHub Action](GITHUB_ACTION.md) uploads
it as a workflow artifact on every run.

```
## Change evidence

| | |
|---|---|
| Change | `origin/main` (4e1c2d9) → `HEAD` (9b7a310) |
| Components | 2 changed |
| Authorship | 3 commit(s), 1 AI-assisted (Claude) |
| Risk | high (2 high, 4 medium) |
| Quality gate | ❌ failed (1 of 3 checks) |
| Tests | 5 generated; 3 passed, 2 failed in my-sandbox |
| Approvals | alice |
| Policy | `.preflight.json` |
| Tool | sf-preflight 0.5.0 |
| Digest | `sha256:…` |
```

## Contents

| Field | What it records |
|---|---|
| `change.base`, `change.head` | Refs and commit SHAs; `uncommitted: true` when the working tree had uncommitted changes |
| `change.components` | Each changed component with its type, file and the SHA-256 of the file at the head |
| `change.authorship` | Commits in the range, which are AI-assisted and which tools, with author names (not emails) |
| `analysis` | Risk, every finding (rule, severity, title, files), impacted objects, cycles, affected agent actions |
| `tests` | Suggested tests, the generated tests and their results in an org (with `--tests-result`) |
| `approvals` | Reviewers who approved (with `--approvals`, or from the pull request in the Action) |
| `gate` | The gate decision and each check |
| `config` | The policy file used and its SHA-256 |
| `repository` | Remote URL (credentials removed) and the project's path in it |
| `tool` | sf-preflight version |
| `digest` | SHA-256 over the canonical JSON of everything else |

Pass the inputs the gate and the record need:

```bash
preflight tests --base origin/main --validate --org my-sandbox --format json > tests.json
preflight evidence --base origin/main --head HEAD \
  --tests-result tests.json --approvals approvals.json --out evidence.json
```

## Verifying

The digest detects any edit to the file:

```bash
preflight evidence --verify evidence.json
# evidence.json: digest OK (sha256:…)
```

A digest proves the file is intact, not who produced it. For that, let the GitHub Action sign
it (`attest: true`) with a [GitHub artifact attestation](GITHUB_ACTION.md#signed-evidence) and
check it with `gh attestation verify`.

## Privacy

The evidence pack contains metadata names, file paths and digests, commit subjects and author
names, reviewer logins and org aliases. It never contains record data, Salesforce usernames,
email addresses or credentials (remote URLs are stripped of any embedded token).
