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
| `org/sf.ts` | Read-only wrapper around the Salesforce CLI (`sf ... --json`), with input validation. |
| `org/enrich.ts` | Optional `--org` context: record counts, org-only automation, assignments, packages; turns it into findings and annotations. |
| `org/validate.ts` | `preflight tests --validate`: check-only deployment of the project and generated tests (`sf project deploy validate`), org safety check, per-test results. |
| `testgen/generate.ts` | `preflight tests`: turns the cascade and findings into an Apex test class (bulk, recursion, idempotency, validation errors surfacing). Every generated class is syntax-checked with the Apex parser. |
| `testgen/solver.ts` | Parses and evaluates validation-rule and entry-criteria formulas (three-valued: a value can be unknown) and finds field values that satisfy or violate them. |
| `testgen/schema.ts` | What the generator knows about standard objects (required, defaulted and read-only fields, standard relationships), plus project field definitions. |
| `testgen/factory.ts` | Source of the generated `PreflightDataFactory`, which builds valid records at run time from the org's describe information. |
| `testgen/markdown.ts` | Summary of generated and skipped tests, with the command to run them. |

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

## Known limitations

- Apex type resolution covers locals, parameters, for-each variables, class fields and
  properties, casts, `new`, inline SOQL, `Trigger.*` and return types of methods in the same
  class. DML on generic `SObject` collections, values returned from other classes and dynamic
  DML (`Database.insert(records)` built from `Schema` describes) are counted as unresolved.
- The call graph merges overloads by method name and does not follow interfaces, virtual
  dispatch or dynamic `Type.forName` instantiation.
- Files that fail to parse use the regex fallback and are listed in the report's warnings.
- Process Builder, legacy workflow rules, duplicate rules, assignment rules, escalation rules
  and sharing recalculation are not modelled yet.
- Order *within* a phase is alphabetical; Salesforce's flow trigger order is not yet read.
