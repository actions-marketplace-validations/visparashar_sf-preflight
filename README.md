# sf-blast-radius

[![CI](https://github.com/visparashar/sf-blast-radius/actions/workflows/ci.yml/badge.svg)](https://github.com/visparashar/sf-blast-radius/actions/workflows/ci.yml)
[![CodeQL](https://github.com/visparashar/sf-blast-radius/actions/workflows/codeql.yml/badge.svg)](https://github.com/visparashar/sf-blast-radius/actions/workflows/codeql.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js 22.12+](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)

**Know what a Salesforce change will set off — before it ships.**

AI coding agents and Headless 360 make Salesforce changes cheap to produce, but verifying them
is still slow and manual. `sf-blast-radius` reads your SFDX project and a git diff, follows the
change through the org's order of execution — flows, triggers, validation rules, roll-ups,
permissions — and reports the blast radius, the risks and the tests that matter.

It is open source, runs offline on your source code, and needs no org credentials.

> **Status:** early (v0.1, milestone M1). The CLI and core analysis work today; the MCP server,
> GitHub Action, live-org enrichment, test generation and Agentforce action verification are on
> the [roadmap](docs/ROADMAP.md). Feedback and contributions are very welcome.

## What it finds

| Finding | Why it matters |
|---|---|
| **Recursion cycles** | `Account → Contact → Account` loops settle at human pace and break at bulk or agent volume |
| **Validation-rule collisions** | An automation or agent action can be *correct* and still fail on a rule it doesn't satisfy |
| **New rules vs existing automation** | A new validation rule silently constrains every flow, trigger and class that writes the object |
| **After-save self-updates** | Re-runs the whole save procedure for the record |
| **Automation density** | Many overlapping automations or multiple triggers on one object hide ordering bugs |
| **DML/SOQL in loops** | In changed Apex and in Apex inside the blast radius |
| **Permission escalations** | New Modify All / View All, delete access, sensitive system permissions — diffed against the base |
| **Broken references** | Deleted fields, flows or classes that are still used |

Every run also produces a **suggested test plan**: bulk, recursion, validation-collision,
idempotency, boundary and permission-negative tests for exactly what the change touches.

## Quick start

Requires Node.js 22.12 or newer.

```bash
git clone https://github.com/visparashar/sf-blast-radius.git
cd sf-blast-radius
npm install && npm run build
npm link            # makes the `blast-radius` command available
```

Once a release is published to npm you will be able to run it without cloning:

```bash
npx sf-blast-radius analyze --base origin/main
```

### Usage

```bash
# Everything changed since origin/main (committed and uncommitted)
blast-radius analyze --project path/to/sfdx-project --base origin/main

# Compare two refs
blast-radius analyze --base origin/main --head HEAD

# Specific files
blast-radius analyze --files force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml

# JSON for machines; exit code 2 when risk is high
blast-radius analyze --base origin/main --format json --out blast-radius.json --fail-on high

# What runs, in order, when an object is saved?
blast-radius explain Opportunity --event update
```

| Option | Default | Description |
|---|---|---|
| `-p, --project <dir>` | `.` | SFDX project directory (reads `sfdx-project.json`) |
| `-b, --base <ref>` | — | Git base ref |
| `--head <ref>` | working tree | Git head ref |
| `-f, --files <paths...>` | — | Analyze these files instead of a git diff |
| `--format <md\|json>` | `md` | Output format |
| `-o, --out <file>` | stdout | Write the report to a file |
| `--depth <n>` | `4` | Maximum cascade depth |
| `--fail-on <level>` | `none` | Exit with code 2 when risk ≥ `low`, `medium` or `high` |

### Example

A one-field change in the bundled [sample org](fixtures/sample-org):

```
Opportunity (update)   [changed: Opportunity.Contract_Signed_Date__c]
├─ flow Opportunity_Closed_Won_Followup → Opportunity (update)  ⟲ cycle
├─ flow Opportunity_Closed_Won_Followup → Task (insert)
└─ roll-up Account.Total_Won_Amount__c → Account (update)
   └─ flow Account_Sync_Tier_To_Contacts → Contact (update)
      └─ trigger ContactTrigger → Account (update)  ⟲ cycle
```

The full Markdown report adds a findings table, the order of execution for each impacted
object, references to the changed field and a test checklist — ready to paste into a PR.

### In CI (GitHub Actions)

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx sf-blast-radius analyze --base origin/${{ github.base_ref }} --out blast-radius.md --fail-on high
- run: cat blast-radius.md >> "$GITHUB_STEP_SUMMARY"
  if: always()
```

A dedicated GitHub Action that comments on pull requests is planned for milestone M2.

### As a library

```ts
import { run, toMarkdown } from "sf-blast-radius";

const result = run({ projectDir: ".", base: "origin/main" });
console.log(result.summary.risk, result.findings.length);
console.log(toMarkdown(result));
```

## How it works

```
SFDX source ─► parsers ─► org model ─► change mapper ─► order of execution ─► cascade ─► findings ─► Markdown / JSON
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and known limitations. In short:
Apex analysis is heuristic in v0.1, and Process Builder, legacy workflow, duplicate and
assignment rules are not modelled yet.

## Contributing

Contributions are welcome — especially reports of wrong or missing findings with a small,
anonymised metadata snippet. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and please
follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)

*Salesforce, Agentforce and related marks are trademarks of Salesforce, Inc. This project is
independent and not affiliated with or endorsed by Salesforce.*
