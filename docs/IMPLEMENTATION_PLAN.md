# Implementation Plan — Salesforce Change Verifier ("blast-radius")

*Status: draft v0.1 · October 5, 2026*

## 1. Problem

AI coding agents (Claude Code, Cursor, Agentforce Vibes, Copado Agentia) and Salesforce Headless 360
have made Salesforce changes cheap to produce. Verifying them has not gotten cheaper. Teams report
testing bottlenecks as their #1 blocker, 43% apply no extra review to AI-generated changes, and
Agentforce Testing Center checks the agent's *decision* but not what the org *does* when the
action executes.

The question nobody answers cheaply today:

> **"If this change ships, what will it set off in *this* org — and how do we prove it's safe?"**

## 2. Product in one sentence

A vendor-neutral, org-aware **change verifier** that runs on every pull request (especially
AI-authored ones) and every Agentforce action, computes the change's **blast radius** through the
org's automation, permissions and data model, generates the tests that matter, and leaves an
audit-ready evidence pack.

## 3. Design principles

1. **Works offline first.** The core runs on SFDX source in a git repo — no org credentials needed
   to get value. Live-org enrichment is additive.
2. **Execution-layer semantics, not UI clicks.** Model Salesforce's order of execution, cascades
   between objects, roll-ups and permissions. That depth is the moat.
3. **One engine, many surfaces.** The same `core` library powers the CLI, the MCP server (for
   coding agents), the GitHub Action and the DevOps Center Testing provider.
4. **Deterministic and explainable.** Every finding cites the metadata file and the path that
   produced it. No LLM in the core analysis loop; LLMs are optional consumers of the output.
5. **Vendor-neutral.** Complements DevOps Center, Gearset, Copado and open-source CI rather than
   replacing a pipeline.

## 4. Architecture

```
                ┌──────────────── surfaces ────────────────┐
  git diff ───► │  CLI   │  MCP server  │  GitHub Action  │  DevOps Center provider │
                └───────────────────────┬──────────────────┘
                                        ▼
┌──────────────────────────────── core ────────────────────────────────┐
│ project loader (sfdx-project.json → package dirs)                    │
│ parsers: objects/fields · validation rules · flows · triggers ·      │
│          apex classes · permission sets/profiles · agent actions     │
│ org graph: nodes (Object, Field, Flow, Trigger, ApexClass, VR,       │
│            PermissionSet, AgentAction) + edges (firesOn, writesTo,   │
│            reads, invokes, references, grants, rollsUpTo)            │
│ change mapper: changed files → components                            │
│ analyzer: impacted objects → order-of-execution → cascade (depth N, │
│           cycle detection) → risk findings → suggested tests         │
│ reporters: Markdown (PR comment) · JSON (machine) · SARIF (later)    │
└──────────────────────────────────────────────────────────────────────┘
                                        ▼
            (M3+) live org enrichment: Tooling API dependencies,
            permission assignments, record volumes, Agentforce traces
```

### Key modeling decisions

- **Order of execution** per object/event (simplified, documented in code):
  before-save flows → before triggers → validation rules → duplicate rules → after triggers →
  assignment/auto-response → workflow → after-save flows → roll-up summary to parent (parent
  re-enters the save procedure) → criteria-based sharing.
- **Cascade:** every automation that writes to object B makes B's save procedure part of the
  blast radius. Traverse to a configurable depth (default 4) and flag cycles as recursion risk.
- **Roll-up summaries** create an implicit child→parent edge.
- **Apex analysis is heuristic** in v0 (typed variables + DML/SOQL statements, DML/SOQL inside loops).
  A real parser (e.g. apex-parser / tree-sitter-sfapex) replaces it in M3.

## 5. Milestones

| # | Milestone | Outcome | Est. |
|---|-----------|---------|------|
| **M0** | Repo, plan, CI | TypeScript repo, tests, GitHub Actions CI | ½ day |
| **M1** | Offline blast-radius analyzer | `blast-radius analyze --base main` on any SFDX repo → Markdown/JSON report: changed components, impacted objects, order of execution, cascade tree, risk findings, suggested tests | 1–2 wks |
| **M2** | Agent & PR surfaces | MCP server (`analyze_change`, `explain_object`) for Claude Code/Cursor/Vibes; GitHub Action posting a PR comment; "AI-authored" detection via commit trailers | 1 wk |
| **M3** | Live-org enrichment | `sf` CLI auth; Tooling API `MetadataComponentDependency`; real permission assignments and record counts; real Apex parser; managed-package awareness | 2 wks |
| **M4** | Test generation | Generate Apex tests from the blast radius: bulk (≥200 + realistic volume), validation-rule collisions, negative permission (`System.runAs`), recursion/idempotency; run in a sandbox; results fed back into the report | 2–3 wks |
| **M5** | Agentforce action verification | Parse agent metadata (planner bundles, topics, actions, invocation targets); blast radius per action; runtime-user effective-access audit; combine with Testing Center results | 2 wks |
| **M6** | Evidence pack & DevOps Center provider | Signed evidence JSON/PDF per change (author human/AI, findings, tests, approvals); register as a DevOps Center Testing provider with quality-gate severities | 2 wks |
| **M7** | Production feedback loop | Map Flow/Apex errors and Agentforce session traces back to the change that introduced them; suggest partial rollback | later |

## 6. M1 scope (what we build first)

**Inputs:** SFDX project directory; `--base`/`--head` git refs *or* `--files` list.

**Parsers (v0):**
- `objects/*/fields/*.field-meta.xml` — fields, formula fields, roll-up summaries
- `objects/*/validationRules/*.validationRule-meta.xml` — active flag, field references in formula
- `flows/*.flow-meta.xml` — record-triggered start (object, before/after save, create/update/delete),
  entry filters, record creates/updates/deletes/lookups (incl. `$Record` and typed variables),
  Apex action calls, subflows, scheduled paths
- `triggers/*.trigger` — object and events; referenced classes
- `classes/*.cls` — typed variables, DML targets, SOQL objects, DML/SOQL in loops, invocable methods
- `permissionsets/*.permissionset-meta.xml`, `profiles/*.profile-meta.xml` — object/field grants,
  View All / Modify All escalations

**Analysis:** changed components → impacted objects → per-object order of execution →
cascade tree with cycle detection → findings → suggested tests.

**Findings (v0):**
| Rule | Severity |
|------|----------|
| Automation cycle across objects (recursion risk) | high |
| Changed field referenced by an active validation rule | medium |
| Validation rule changed/added on an object that automations write to | medium |
| Many automations on the same object + event (≥3) | medium |
| DML or SOQL inside a loop in a changed/impacted Apex class | high |
| Permission set grants Modify All / View All, or new delete access | high |
| After-save flow updates its own triggering record (`$Record` re-entry) | medium |
| Changed component is deleted but still referenced | high |

**Output:** Markdown (GitHub-flavored, ready for PR comment) and JSON (stable schema, versioned).

**Exit criteria:** on the sample fixture org, a diff touching an Opportunity field produces a report
that surfaces the validation-rule collision, the Account↔Contact recursion cycle, the roll-up
cascade and the over-permissioned permission set — with tests passing in CI.

## 7. Repo layout

```
docs/                 plan, architecture notes
src/core/             loader, parsers, graph, analyzer, reporters
src/cli.ts            command-line entry point
test/                 vitest unit + fixture tests
fixtures/sample-org/  SFDX project reproducing known failure modes
.github/workflows/    CI
```

Single package for now; split into `core` / `cli` / `mcp` / `action` packages when M2 lands.

## 8. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Gearset / Copado / Salesforce ship similar features | Go deeper on execution semantics; stay neutral and embeddable (MCP, Action, provider) |
| Order of execution is complex and changes 3×/year | Encode it in one module with tests; version it per API release |
| Heuristic Apex analysis misses things | Mark confidence per finding; real parser in M3; Tooling API dependencies |
| Profiles and large orgs are huge | Stream parsing, caching, analyze only reachable subgraph |
| Realistic test data for M4 | Generate minimal data factories from required fields + VRs; integrate seeding tools later |

## 9. Validation (runs alongside the build)

- 15–20 interviews with release managers/architects: "the last incident that passed every test".
- Run the analyzer on 3–5 real (anonymized) orgs before M3; measure precision of findings.
- Early design partners: one DevOps Center shop, one open-source-CI shop, one Agentforce adopter.
