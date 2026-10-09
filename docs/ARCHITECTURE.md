# Architecture

```
git diff / --files
        │
        ▼
┌───────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   ┌───────────┐
│ project loader│──►│   parsers    │──►│  org model   │──►│     analyzer     │──►│ reporters │
│ (project.ts)  │   │ (parsers/*)  │   │ (types.ts)   │   │ (analyze.ts)     │   │ md / json │
└───────────────┘   └──────────────┘   └──────────────┘   └──────────────────┘   └───────────┘
                                              ▲                    │
                                              │      graph.ts, orderOfExecution.ts
                                              └────────────────────┘
```

## Modules

| Module | Responsibility |
|---|---|
| `project.ts` | Reads `sfdx-project.json`, walks package directories, classifies each file by its source-format path and dispatches to a parser. Builds the `OrgModel`. |
| `parsers/fields.ts` | Custom fields, formula references, roll-up summary definitions. |
| `parsers/validationRules.ts` | Active flag, formula and the fields it references. |
| `parsers/flows.ts` | Record-triggered start conditions and the objects a flow writes, resolving `$Record`, typed variables, Get Records outputs and loop variables. |
| `parsers/apexAst.ts` | Apex analysis on a real parse tree ([@apexdevtools/apex-parser](https://github.com/apex-dev-tools/apex-parser)): DML targets with type resolution, SOQL reads, method calls (with enclosing method and loop context), field references and field writes. |
| `parsers/apex.ts` | Entry points for triggers and classes. Uses `apexAst.ts`, and falls back to regex heuristics for files with syntax errors (with a warning). |
| `callGraph.ts` | Cross-method and cross-class pass: which methods perform DML/SOQL directly or through callees, and which loops call them. |
| `parsers/permissions.ts` | Object, field and system permissions in permission sets and profiles. |
| `graph.ts` | Derived relationships: effective writes of a trigger/flow/class (following handlers, Apex actions and subflows), writers of an object, callers of a class. |
| `orderOfExecution.ts` | The simplified save procedure for an object and DML event. |
| `changes.ts` | `git diff` → changed files → component changes; reading files at the base ref. |
| `analyze.ts` | Seeds roots from changes, expands the cascade, detects cycles, produces findings and suggested tests. |
| `report/markdown.ts` | GitHub-flavoured Markdown for PR comments. JSON is the `AnalysisResult` object itself. |
| `report/sarif.ts` | SARIF 2.1.0 for code scanning. |
| `org/sf.ts` | Wrapper around the Salesforce CLI (`sf ... --json`), with input validation. Everything is read-only except check-only deployments and Testing Center runs, which refuse production orgs by default. `api request rest` (raw output) reads event log files. |
| `org/enrich.ts` | Optional `--org` context: record counts, org-only automation, assignments, packages; turns it into findings and annotations. |
| `config.ts` | `.preflight.json`: validation, discovery (project, then git root), rule overrides and path ignores. |
| `gate.ts` | The quality gate: findings threshold, approvals for AI-assisted changes, agent test coverage, generated tests passed, Testing Center tests passed. |
| `evidence.ts` | The evidence pack: change identity and file digests, authorship, findings, tests, approvals, gate, and a SHA-256 over its canonical JSON. |
| `report/junit.ts` | JUnit XML for CI test reports. |
| `parsers/agents.ts` | Agentforce metadata: bots and versions, planner bundles, topics (GenAiPlugin), actions (GenAiFunction), Agent Script (`.agent`) and Testing Center definitions, linked into agents → topics → actions. |
| `agentImpact.ts` | Which agent actions a change reaches (through the class or flow they call and the save procedures that follow), Testing Center coverage, runtime-user access needs; `preflight agents`. |
| `org/agentTests.ts` | `preflight agent-tests`: picks the Testing Center tests that cover a change, runs them with `sf agent test run`, reads both result formats, and checks saved results for the gate. |
| `incidents/classify.ts` | Reduces production error messages to metadata: kind of failure, exception type, status code, the validation rule and fields they name. Messages are never kept. |
| `incidents/collect.ts` | `preflight incidents`: reads failed flow interviews, unhandled Apex exceptions (event log), failed async Apex and Agentforce action errors from an org, read-only, or imports errors from a file; groups them. |
| `incidents/trace.ts` | Recent first-parent history, each change's blast radius per component, and the evidence and timing that point an error at a change. |
| `incidents/rollback.ts` | `preflight rollback`: partial rollback plans (restore, deactivate, keep), the components that keep them consistent, and applying them to the working tree. |
| `org/validate.ts` | `preflight tests --validate`: check-only deployment of the project and generated tests (`sf project deploy validate`), org safety check, per-test results. |
| `testgen/generate.ts` | `preflight tests`: turns the cascade and findings into an Apex test class (bulk, recursion, idempotency, validation errors surfacing). Every generated class is syntax-checked with the Apex parser. |
| `testgen/solver.ts` | Parses and evaluates validation-rule and entry-criteria formulas (three-valued: a value can be unknown) and finds field values that satisfy or violate them. |
| `testgen/schema.ts` | What the generator knows about standard objects (required, defaulted and read-only fields, standard relationships), plus project field definitions. |
| `testgen/factory.ts` | Source of the generated `PreflightDataFactory`, which builds valid records at run time from the org's describe information. |
| `testgen/markdown.ts` | Summary of generated and skipped tests, with the command to run them. |
| `skill.ts` | `preflight skill install`: copies the agent skill (`skills/sf-preflight/`, shipped in the package) to the folders agents read. |

Outside `src/`, `skills/sf-preflight/` is the agent skill (Agent Skills format), and
`.claude-plugin/` with `hooks/` make the repository a Claude Code plugin and marketplace that
bundle the skill, the MCP server (`src/mcp.ts`) and an edit hook. See
[AI_AGENTS.md](AI_AGENTS.md).

## Key concepts

**Root.** A starting point for the cascade: an `(object, event)` pair plus the change that
caused it. A changed field roots its object's insert and update; a changed record-triggered flow
roots its trigger object; a changed invocable class roots the objects it writes.

**Save procedure.** For an `(object, event)`, the ordered list of automations Salesforce runs:
before-save flows → before triggers → validation rules → after triggers → after-save flows →
roll-up summaries. Each step carries the writes it performs.

**Cascade.** A tree built by following every write in a save procedure to the target object's
own save procedure, up to `--depth`. When an object already appears on the current path, the
node is marked as a cycle and not expanded further.

**Finding.** A rule result with a severity, a human-readable explanation and the files involved.
Overall risk is the highest severity found.

**Generated test.** A test method for a property any correct implementation should have (bulk
safety, bounded recursion, idempotency, errors surfacing), with the field values it needs worked
out from flow entry criteria and validation rules. The runtime data factory fills in everything
else, so tests don't depend on org-specific required fields. See [TESTS.md](TESTS.md).

## Adding a metadata parser

1. Add a classification for the file pattern in `classifyPath()` (`project.ts`).
2. Create `src/core/parsers/<type>.ts` that turns the XML/source into a typed definition
   (add the type to `types.ts`).
3. Store it on `OrgModel` in `loadProject()`.
4. Teach `graph.ts` / `orderOfExecution.ts` about any writes or ordering it introduces.
5. Add parser tests in `test/parsers.test.ts` and, if it changes analysis, a fixture component
   plus expectations in `test/analyze.test.ts`.

## Adding a rule

Rules live in `analyze.ts`, grouped by stage:

- **Change-specific rules** run while seeding roots (e.g. a new validation rule vs existing
  automation).
- **Cascade rules** run over the visited save procedures and edges (e.g. cycles, validation-rule
  collisions, automation density).

A rule should push a `Finding` with a stable `rule` id (kebab-case), a severity, a title that
reads well in a table, a detail that explains *why it matters*, and the files involved. If the
rule implies something worth testing, also push a `SuggestedTest`.

## Metadata types and coverage

Every Salesforce metadata type is recognized by name, from a table generated out of Salesforce's
metadata registry (`scripts/gen-metadata-types.mjs` writes `src/core/metadataTypes.ts`; the
registry is not a run-time dependency). Types with their own analysis (fields, validation rules,
flows, Apex, permissions, Agentforce) are "analyzed in depth". Every other changed component
(layouts, Lightning components, flexipages, labels, custom metadata, ...) is a `Metadata`
component: it appears in the changed components, raises an info finding
(`metadata-not-analyzed`), and the result's `coverage` lists, per component, the project files
that mention its API name (`c-my-cmp`, `c/myCmp` and `c:myCmp` for Lightning components).
`coverage.deep` and `coverage.basic` give the "analyzed in depth: N of M" line in reports. The
mention search is by name: it finds where to look and does not follow what those files do.

## Known limitations

- Apex type resolution covers locals, parameters, for-each variables, class fields and
  properties, casts, `new`, inline SOQL, `Trigger.*` and return types of methods in the same
  class. DML on generic `SObject` collections, values returned from other classes and dynamic
  DML (`Database.insert(records)` built from `Schema` describes) are counted as unresolved.
- The call graph merges overloads by method name and does not follow interfaces, virtual
  dispatch or dynamic `Type.forName` instantiation.
- Files that fail to parse use the regex fallback and are listed in the report's warnings.
- Types listed under *Metadata types and coverage* above are reported by name only.
- Process Builder, legacy workflow rules, duplicate rules, assignment rules, escalation rules
  and sharing recalculation are not modelled yet.
- Order *within* a phase is alphabetical; Salesforce's flow trigger order is not yet read.
