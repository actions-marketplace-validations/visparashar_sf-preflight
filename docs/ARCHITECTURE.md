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
