# Generated tests

`preflight tests` turns the blast radius of a change into Apex tests you can run in a sandbox or
scratch org. The analyzer tells you *what* a change sets off; the generated tests check that it
holds up when it does.

```bash
preflight tests --base origin/main
```

It writes two classes to `preflight-tests/classes/` in your project and prints a summary of what
it generated, what it didn't and why, and how to run them.

## What gets generated

The tests check properties any correct implementation should have, not your business rules:

| Test | Generated for | Checks |
|---|---|---|
| **Bulk** (`bulkUpdateOpportunity`, …) | Each object and save event the change affects directly (insert, update, delete) | Saving 200 records at once succeeds: no governor-limit failures, no validation errors from your own automation. Records are set up to meet the entry criteria of the flows involved, so the automation actually runs. |
| **Recursion** (`recursionAccountContact`, …) | Each automation cycle across objects, e.g. `Account → Contact → Account` | Updating 200 records that start the cycle, with related records in place so every hop fires, completes without hitting recursion or governor limits. |
| **Idempotency** (`idempotent<Flow>`) | After-save flows that update their own record and create related records | Saving the same record again without changes doesn't create the related records a second time. |
| **Validation errors surface** (`surfacesErrors<Class><Rule>`) | Invocable actions that write a field a validation rule checks | When the rule blocks the action's write, the action raises an error instead of silently leaving the record unchanged. This is the failure mode agents and flows can't see. |

Permission tests are listed but not generated: who should be allowed to do what is a business
decision. The suggested tests in `preflight analyze` describe what to cover with
`System.runAs`.

## How the test data is built

Generated tests never hard-code your org's schema. They use a generated data factory,
`PreflightDataFactory`, that reads the schema at run time (`Schema.describe`) and fills every
required field with a valid value: the default or first active picklist value, a shared parent
record for required lookups and master-detail fields, unique text, today's date, and so on.

On top of that, preflight works out the values each test needs from your metadata:

- **Flow entry criteria** (`StageName = 'Closed Won'`, `Customer_Tier__c` *is changed*) so the
  automation runs.
- **Validation rules** on the object, so the test records are accepted. Preflight evaluates rule
  formulas (`AND`, `OR`, `NOT`, `IF`, `ISBLANK`, `ISPICKVAL`, `ISCHANGED`, `ISNEW`, `TEXT`,
  comparisons and arithmetic) and picks values that satisfy all of them together.
- **Relationships** between the objects in a cycle (`Contact.AccountId`), from flow assignments,
  roll-up summaries, lookup fields and standard relationships. When a save cascades into a parent
  record (a roll-up summary, or automation that updates the parent), the bulk records share one
  parent so that part of the cascade runs too.

When a value can't be worked out — a rule using functions preflight doesn't evaluate, or two
rules that contradict the values a test needs — the test is still generated, with a `NOTE`
comment naming the rule. Adjust the values there if the test fails on that rule.

## Running them

Run the tests together with your change, for example as a check-only deployment, which runs the
tests and rolls everything back. Run it from the project directory:

```bash
sf project deploy validate --source-dir force-app --source-dir preflight-tests \
  --test-level RunSpecifiedTests --tests PreflightChangeTest --target-org my-sandbox
```

`preflight tests` prints this command with your project's package directories filled in. Use a
sandbox or scratch org, never production.

A failing test points at one of two things:

- **A real risk**: a governor limit at bulk volume, a recursion loop, automation applied twice,
  or an action that swallows validation errors. The assertion message says which.
- **Test data the org rejects**, for example a validation rule, duplicate rule or required field
  that only exists in the org. The `NOTE` comments say which values to adjust; `--org` context
  in `preflight analyze` lists automation that exists only in the org.

The generated classes are a starting point. Keep the ones that are useful in your project's own
test suite, rename them, and extend them with assertions about your business rules.

## Options

| Option | Default | Description |
|---|---|---|
| `-p, --project <dir>` | `.` | SFDX project directory |
| `-b, --base <ref>` | — | Git base ref |
| `--head <ref>` | working tree | Git head ref |
| `-f, --files <paths...>` | — | Use these files as the change instead of a git diff |
| `-o, --out <dir>` | `<project>/preflight-tests` | Where to write the classes |
| `--prefix <name>` | `Preflight` | Prefix for the class names |
| `--class-name <name>` | `<prefix>ChangeTest` | Name of the test class |
| `--bulk-size <n>` | `200` | Records per bulk test (1–10,000) |
| `--depth <n>` | `4` | Maximum cascade depth |
| `--dry-run` | — | Print the summary without writing files |
| `--format <md\|json>` | `md` | Summary format |

The default output directory is outside your package directories, so the tests aren't deployed
with the rest of your project unless you move them. Add `preflight-tests/` to `.gitignore` if you
regenerate them on every change, or pass `--out force-app/main/default` to keep them with your
source.

## From coding agents

The MCP server's `generate_tests` tool returns the same summary and the Apex classes as code,
without writing anything to disk; the agent saves them into a package directory. See
[MCP.md](MCP.md).

## Limitations

- Tests are generated for record-triggered flows, Apex triggers and invocable Apex actions.
  Undelete tests, cycles that start on delete, and invocable actions with parameters other than
  `List<Id>` or `List<SObject type>` are listed as not generated.
- Values come from your project's source. Validation rules, required fields and automation that
  exist only in the org can make the generated data fail; the test then fails with the org's
  error message.
- The data factory can't create records of objects that need special setup (for example `User`,
  setup objects, or objects only available with a feature license).
- Generated Apex is checked for syntax before it's written, but it is compiled by Salesforce: a
  field or class referenced by the tests must exist in the target org or be part of the
  deployment.
