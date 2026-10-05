# sf-preflight

[![CI](https://github.com/visparashar/sf-preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/visparashar/sf-preflight/actions/workflows/ci.yml)
[![CodeQL](https://github.com/visparashar/sf-preflight/actions/workflows/codeql.yml/badge.svg)](https://github.com/visparashar/sf-preflight/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/sf-preflight.svg)](https://www.npmjs.com/package/sf-preflight)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)

**Preflight checks for Salesforce changes: know what a change will set off — before it ships.**

AI coding agents and Headless 360 make Salesforce changes cheap to produce, but verifying them
is still slow and manual. `sf-preflight` reads your SFDX project and a git diff, follows the
change through the org's order of execution — flows, triggers, validation rules, roll-ups,
permissions — and reports the blast radius, the risks and the tests that matter.

It is open source, runs offline on your source code, and needs no org credentials.

> **Status:** early (0.x). The CLI, MCP server, GitHub Action, test generation and Agentforce
> action verification work today; org context is in beta. See the [roadmap](docs/ROADMAP.md).
> Feedback and contributions are very welcome.

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
| **Affected agent actions** | Agentforce actions the change reaches, their Testing Center coverage and what their runtime user needs |

Every run also produces a **suggested test plan**: bulk, recursion, validation-collision,
idempotency, boundary and permission-negative tests for exactly what the change touches — and
`preflight tests` [generates the Apex](#generate-tests) for them.

## Quick start

Requires Node.js 22.13 or newer. Run it from the root of an SFDX project:

```bash
npx sf-preflight analyze --base origin/main
```

or install the `preflight` command globally:

```bash
npm install -g sf-preflight
preflight analyze --base origin/main
```

To run from source instead, see [CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

### Usage

```bash
# Everything changed since origin/main (committed and uncommitted)
preflight analyze --project path/to/sfdx-project --base origin/main

# Compare two refs
preflight analyze --base origin/main --head HEAD

# Specific files
preflight analyze --files force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml

# JSON for machines; exit code 2 when risk is high
preflight analyze --base origin/main --format json --out preflight.json --fail-on high

# What runs, in order, when an object is saved?
preflight explain Opportunity --event update

# What can an Agentforce agent do, and what do its actions save?
preflight agents Sales_Agent
```

| Option | Default | Description |
|---|---|---|
| `-p, --project <dir>` | `.` | SFDX project directory (reads `sfdx-project.json`) |
| `-b, --base <ref>` | — | Git base ref |
| `--head <ref>` | working tree | Git head ref |
| `-f, --files <paths...>` | — | Analyze these files instead of a git diff |
| `--format <md\|json\|sarif>` | `md` | Output format |
| `--md-out`, `--json-out`, `--sarif-out <file>` | — | Also write the report in another format |
| `-o, --out <file>` | stdout | Write the report to a file |
| `--depth <n>` | `4` | Maximum cascade depth |
| `--org <alias>` | — | Beta: add read-only context from an org authorized with `sf org login` ([details](docs/ORG_CONTEXT.md)) |
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

### Generate tests

```bash
preflight tests --base origin/main
```

Writes Apex tests for exactly what the change touches to `preflight-tests/`: bulk saves of 200
records, recursion along automation cycles, flows that must not apply twice, and invocable
actions that must not swallow validation errors. Test data comes from a schema-aware data
factory, with values chosen to meet your flows' entry criteria and pass your validation rules.
Add `--validate --org my-sandbox` to run them right away: preflight deploys your project and the
tests check-only (Salesforce compiles and runs everything, then rolls it back) and reports each
test's result.

```bash
preflight tests --base origin/main --validate --org my-sandbox
```

See [docs/TESTS.md](docs/TESTS.md) for what is generated and how to read a failure.

### Agentforce agents

```bash
preflight agents Sales_Agent
```

Preflight reads agents from source, both Agent Builder metadata and Agent Script (`.agent`
files), and follows each action to the Apex class or flow it calls and the records that saves.
Every analysis then reports the agent actions a change reaches, whether Testing Center tests
cover them, and the access their runtime user needs. With `--org`, it checks that user's real
permissions. See [docs/AGENTS.md](docs/AGENTS.md).

### On pull requests (GitHub Action)

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: visparashar/sf-preflight@v0
    with:
      fail-on: high
```

The action comments the report on the PR (and keeps that comment updated), writes it to the job
summary, can upload findings to code scanning as SARIF, and exposes `risk` and
`ai-assisted-commits` outputs. See [docs/GITHUB_ACTION.md](docs/GITHUB_ACTION.md).

### From coding agents (MCP)

```bash
claude mcp add sf-preflight -- npx -y sf-preflight mcp
```

`preflight mcp` is a read-only MCP server with five tools — `analyze_change`,
`explain_save_order`, `find_field_references`, `explain_agent` and `generate_tests` — so Claude
Code, Cursor, VS Code agents and other MCP clients can check their own Salesforce changes, and
write the tests for them, before committing. Setup for each
client is in [docs/MCP.md](docs/MCP.md).

### With org context (beta)

```bash
preflight analyze --base origin/main --org my-sandbox
```

Your SFDX source isn't the whole truth: orgs collect automation that never made it into the
repo. With `--org`, preflight asks the org (read-only, through your existing `sf` CLI login)
for record volumes of the impacted objects, active flows, triggers and validation rules that
exist only in the org, how many users hold the permission sets you changed, and installed
packages. The report contains only counts and metadata names. See
[docs/ORG_CONTEXT.md](docs/ORG_CONTEXT.md).

### AI-assisted changes

When analyzing a git range, preflight reads commit trailers and tool markers (Claude, Copilot,
Cursor, Codex, Gemini, Devin and others) and reports how many commits were AI-assisted, so
reviewers know where to look harder. The analysis itself is identical for human and AI changes.

### As a library

```ts
import { run, toMarkdown } from "sf-preflight";

const result = run({ projectDir: ".", base: "origin/main" });
console.log(result.summary.risk, result.findings.length);
console.log(toMarkdown(result));
```

## How it works

```
SFDX source ─► parsers ─► org model ─► change mapper ─► order of execution ─► cascade ─► findings ─► Markdown / JSON / SARIF
                                                                                               └─► generated Apex tests
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and known limitations, and
[docs/RULES.md](docs/RULES.md) for every rule. In short:
Process Builder, legacy workflow, duplicate and assignment rules are not modelled yet, and the
Apex call graph doesn't follow interfaces or dynamic dispatch.

## Contributing

Contributions are welcome — especially reports of wrong or missing findings with a small,
anonymised metadata snippet. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and please
follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)

*Salesforce, Agentforce and related marks are trademarks of Salesforce, Inc. This project is
independent and not affiliated with or endorsed by Salesforce.*
