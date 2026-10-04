# sf-blast-radius

**Know what a Salesforce change will set off — before it ships.**

AI coding agents and Headless 360 make Salesforce changes cheap to produce. Verifying them is
still slow and manual. `sf-blast-radius` reads your SFDX project and a git diff, follows the
change through the org's order of execution — flows, triggers, validation rules, roll-ups,
permissions — and reports the blast radius, the risks and the tests that matter.

> Status: **v0.1 / milestone M1** — offline static analysis of SFDX source. See
> [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the roadmap (MCP server,
> GitHub Action, live-org enrichment, test generation, Agentforce action verification).

## What it finds

- **Cascades** — which objects a change touches, transitively, via automation writes and roll-ups
- **Recursion cycles** — e.g. `Account → Contact → Account` loops that only break at bulk/agent volume
- **Validation-rule collisions** — automations that write to objects guarded by rules they may not satisfy
- **Self re-entry** — after-save flows that update their own triggering record
- **Automation density** — objects with many overlapping automations or multiple triggers
- **DML/SOQL in loops** — in changed Apex and in Apex inside the blast radius
- **Permission escalations** — new Modify All / View All, delete access, sensitive system permissions
- **Broken references** — deleted fields, flows or classes that are still used

Each run also produces a **suggested test plan** (bulk, recursion, validation-collision,
idempotency, boundary, permission-negative).

## Quick start

```bash
npm install
npm run build

# Analyze everything changed since origin/main (committed + uncommitted)
node dist/cli.js analyze --project path/to/sfdx-project --base origin/main

# Analyze specific files
node dist/cli.js analyze --project fixtures/sample-org \
  --files fixtures/sample-org/force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml

# JSON for machines, fail CI on high risk
node dist/cli.js analyze --base origin/main --format json --out blast-radius.json --fail-on high

# What runs, in order, when an object is saved?
node dist/cli.js explain Opportunity --project fixtures/sample-org --event update
```

Example output (abridged) for a one-field change in the sample org:

```
Opportunity (update)   [changed: Opportunity.Contract_Signed_Date__c]
├─ flow Opportunity_Closed_Won_Followup → Opportunity (update)  ⟲ cycle
├─ flow Opportunity_Closed_Won_Followup → Task (insert)
└─ roll-up Account.Total_Won_Amount__c → Account (update)
   └─ flow Account_Sync_Tier_To_Contacts → Contact (update)
      └─ trigger ContactTrigger → Account (update)  ⟲ cycle
```

## How it works

```
SFDX source ─► parsers ─► org graph ─► change mapper ─► order of execution ─► cascade ─► findings ─► Markdown / JSON
```

- **Parsers:** fields (incl. roll-up summaries and formulas), validation rules, record-triggered
  flows (`$Record`, typed variables, Get Records outputs, loops, subflows, Apex actions), Apex
  triggers and classes (heuristic DML/SOQL analysis), permission sets and profiles.
- **Order of execution:** before-save flows → before triggers → validation rules → after
  triggers → after-save flows → roll-up summaries (parent re-enters its save).
- **Cascade:** follows writes object-to-object to a configurable depth and flags re-entry.

Known gaps in v0: legacy workflow rules and Process Builder are reported but not analyzed;
Apex analysis is regex-based; duplicate/assignment rules and sharing recalculation are not
modelled. All of these are on the roadmap.

## Development

```bash
npm test          # vitest
npm run typecheck
npm run build
```

`fixtures/sample-org` is a small SFDX project that deliberately reproduces common failure
modes (validation-rule collision, cross-object recursion, after-save self-update, SOQL in a
loop, over-permissioned agent runtime user). Tests assert the analyzer catches each one.
