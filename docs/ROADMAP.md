# Roadmap

sf-preflight aims to answer one question for every Salesforce change — human- or
AI-authored — before it ships:

> **If this change ships, what will it set off in this org, and how do we prove it's safe?**

## Principles

1. **Offline first.** The core runs on SFDX source in a git repo with no org credentials.
   Connecting to an org adds precision; it is never required.
2. **Execution-layer semantics.** Model the order of execution, cross-object cascades,
   roll-ups and permissions — not UI clicks.
3. **One engine, many surfaces.** The same core library powers the CLI, an MCP server for
   coding agents, a GitHub Action and pipeline integrations.
4. **Deterministic and explainable.** Every finding cites the metadata and the path that
   produced it. No LLM in the core analysis loop.
5. **Tool-neutral.** Works alongside DevOps Center, open-source CI and commercial DevOps tools.

## Milestones

| | Milestone | Outcome | Status |
|---|---|---|---|
| **M0** | Foundation | TypeScript project, tests, CI, open-source governance | ✅ done |
| **M1** | Offline preflight analyzer | `preflight analyze` on any SFDX repo → Markdown/JSON report with changed components, cascade, order of execution, findings and suggested tests | 🚧 in progress |
| **M2** | Agent & PR surfaces | MCP server (`analyze_change`, `explain_object`) for Claude Code, Cursor, Agentforce Vibes and other MCP clients; GitHub Action that comments on PRs; SARIF output for code scanning | planned |
| **M3** | Live-org enrichment | Optional `sf` CLI auth; Tooling API `MetadataComponentDependency`; real permission assignments and record volumes; full Apex parser; managed-package awareness | planned |
| **M4** | Test generation | Generate Apex tests from the blast radius — bulk, validation-rule collision, negative permission (`System.runAs`), recursion and idempotency — and run them in a sandbox | planned |
| **M5** | Agentforce action verification | Parse agent metadata (topics, actions, invocation targets); blast radius per agent action; runtime-user effective-access audit; combine with Agentforce Testing Center results | planned |
| **M6** | Evidence & pipeline integration | Evidence pack per change (author human/AI, findings, tests, approvals); DevOps Center Testing provider with quality-gate severities | planned |
| **M7** | Production feedback loop | Map production Flow/Apex errors and agent session traces back to the change that introduced them; suggest partial rollback | exploring |

## M1 — remaining work

- [ ] Process Builder and legacy workflow rule parsing
- [ ] Record-triggered flow trigger order (`triggerOrder`) within a phase
- [ ] Before-save flow field assignments as field-level writes
- [ ] Apex: `Trigger.newMap` handlers, `Database.SaveResult` handling detection, platform events
- [ ] Master-detail cascade delete edges
- [ ] Configurable rule severities and ignores (`.preflight.json`)
- [ ] Performance pass on large orgs (streaming profile parsing, caching)

## Out of scope (for now)

- Deploying metadata or replacing a CI/CD pipeline
- UI test automation
- Data backup and restore

Have an idea? Open a [feature request](https://github.com/visparashar/sf-preflight/issues/new/choose).
