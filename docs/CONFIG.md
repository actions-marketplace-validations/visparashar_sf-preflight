# Configuration and quality gate

Put a `.preflight.json` in your SFDX project (or at the repository root) to tune rules and define
the quality gate. Every command, the MCP server and the GitHub Action pick it up.

```json
{
  "$schema": "https://raw.githubusercontent.com/visparashar/sf-preflight/main/schema/preflight.schema.json",
  "rules": {
    "dml-or-soql-in-loop": "high",
    "legacy-workflow": "off"
  },
  "ignore": {
    "paths": ["force-app/main/default/classes/Legacy*.cls"]
  },
  "gate": {
    "failOn": "high",
    "aiAssistedApprovals": 1,
    "requireAgentTests": true,
    "requireTestsPassed": false
  }
}
```

Unknown settings and rule ids are errors, so a typo can't silently weaken the gate. The
`$schema` line gives editors completion and validation.

## Rules

| Setting | Meaning |
|---|---|
| `rules.<rule-id>` | `high`, `medium`, `low` or `info` to change a rule's severity; `off` to drop its findings. Rule ids are in [RULES.md](RULES.md). |
| `ignore.paths` | Glob patterns relative to the project (`*` within a folder, `**` across folders, `?` one character). A finding is dropped when all of its files match. |

The report notes the policy file it used, and the risk is recalculated after overrides.

## Quality gate

The gate turns a change into one pass/fail decision. Run it with `--gate`:

```bash
preflight analyze --base origin/main --gate
```

It exits with code 2 when the gate fails, and the report starts with the checks:

| Check | Setting | Passes when |
|---|---|---|
| Findings | `failOn` (default `high`; `--fail-on` overrides it) | No finding is at or above that severity. `none` disables the check. |
| AI-assisted approvals | `aiAssistedApprovals` (default 0, off) | The change has no AI-assisted commits, or at least that many people approved it. |
| Agent test coverage | `requireAgentTests` | Every agent action the change affects is covered by a Testing Center test ([AGENTS.md](AGENTS.md)). |
| Generated tests | `requireTestsPassed` | The generated Apex tests ran in an org and passed ([TESTS.md](TESTS.md)). |

Approvals and test results come from the pipeline:

- `--approvals <file>`: a JSON list of reviewers, `["alice", "bob"]` or
  `[{ "reviewer": "alice", "submittedAt": "…" }]`. The [GitHub Action](GITHUB_ACTION.md#approvals)
  reads them from the pull request's reviews.
- `--tests-result <file>`: the output of
  `preflight tests --validate --org <sandbox> --format json`.

When a check needs data that wasn't provided (approvals for an AI-assisted change, or test
results), it fails and says what to pass, rather than passing silently.

AI-assisted commits are recognised from co-author trailers and tool markers (Claude, Copilot,
Cursor, Codex, Gemini, Devin and others).

## Output formats for pipelines

| Format | Use |
|---|---|
| `--format md` | Pull request comments and job summaries |
| `--format json` | Everything, including the gate, for scripts |
| `--format sarif` | GitHub code scanning and other SARIF viewers |
| `--format junit` | Test reports in GitLab, Azure DevOps, Jenkins, Bitbucket and most CI systems: one test case per gate check and per finding |
| `--evidence-out <file>` | The [evidence pack](EVIDENCE.md) for audits |

Each has a matching `--<format>-out <file>` option so one run can write several.
