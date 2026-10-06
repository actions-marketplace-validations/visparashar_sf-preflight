# Production errors and partial rollback

Preflight checks a change before it ships. `preflight incidents` closes the loop afterwards: it
reads recent errors from production, traces each one back to the merged change most likely to
have caused it, and `preflight rollback` plans a partial rollback of just the components
involved.

```bash
preflight incidents --org prod                     # errors from the last 7 days, traced to changes
preflight incidents --org prod --since 24h --ref origin/main
preflight rollback 9c607ea --component Opportunity.Require_Close_Reason          # the plan
preflight rollback 9c607ea --component Opportunity.Require_Close_Reason --restore  # apply it locally
```

Everything `incidents` does in the org is read-only, so it's safe to run against production.

## Example

```markdown
### Production errors in prod since 2026-09-29

Read: Failed flow interviews (12) · Unhandled Apex exceptions (4) · Failed asynchronous Apex (1).
Not available: Agentforce action errors (beta) (needs Agentforce session tracing in Data 360).

**3 problems, 2 traced to recent changes.** Checked 14 changes on `origin/main` since 2026-09-02.

| # | Error | Where | Count | First seen | Last seen | Likely cause |
|---|---|---|---|---|---|---|
| 1 | A validation rule blocked a save (validation rule `Opportunity.Require_Close_Reason`) | agent action `Close_Opportunity` | 5 | 2026-10-03 08:00 | 2026-10-05 09:00 | `9c607ea` #12 (high) |
| 2 | Too many SOQL queries (System.LimitException) | Apex class `ContactTriggerHandler` | 1 | 2026-10-05 12:00 | 2026-10-05 12:00 | `21fbf4b` #13 (high) |
| 3 | Null reference | flow `Update_Customer_Tier` | 2 | 2026-09-30 08:00 | 2026-10-05 08:00 | — |

#### 1. A validation rule blocked a save (validation rule `Opportunity.Require_Close_Reason`) in agent action `Close_Opportunity`

- **`9c607ea` #12** Add close reason rule (2026-10-02) · high confidence
  - It added validation rule `Opportunity.Require_Close_Reason`, and the error is that rule's message.
  - Preflight flagged it for this change: New validation rule Opportunity.Require_Close_Reason applies to 3 automation(s) that write Opportunity.
  - The errors started 2 hours after validation rule `Opportunity.Require_Close_Reason` changed in the org (2026-10-03).
  - Partial rollback: `preflight rollback 9c607ea --component Opportunity.Require_Close_Reason`
```

## Where the errors come from

| Source | What preflight reads | Needs |
|---|---|---|
| Failed flow interviews | `FlowInterview` records with status `Error`: the flow, the element that failed, when, and the error | Orgs that keep failed interviews (Setup → Paused and Failed Flow Interviews) |
| Unhandled Apex exceptions | The `ApexUnexpectedException` event log file: exception type, message and stack trace | Event log files (the daily file is free in most editions and kept for about a day); a Salesforce CLI with `sf api request rest` |
| Failed asynchronous Apex | `AsyncApexJob` records that failed or had errors (batch, queueable, future, scheduled) | — |
| Agentforce action errors (beta) | Steps with an error in Agentforce session tracing (`ssot__AiAgentInteractionStep__dlm`): the action, its topic and the error | Data 360 with Agentforce session tracing turned on |
| Imported errors | A JSON file you pass with `--errors` (below) | — |

Run it as a user who can see setup data and event logs (an administrator, or a read-only
integration user with View Setup and Configuration and View Event Log Files). A source that isn't
available is reported as such and the others still run. `--source flow apex`
reads only some of them. Retention differs per source, so a short `--since` is more complete
than a long one: the free Apex event log covers about a day, failed jobs about a week.

### What it runs

All through the Salesforce CLI you're logged in with, read-only:

```sql
-- sf org display, then sf sobject describe --sobject FlowInterview (to check which fields the org has)
SELECT FlowVersionViewId, CurrentElement, InterviewLabel, CreatedDate, <error field>
  FROM FlowInterview WHERE InterviewStatus = 'Error' AND CreatedDate >= ...
SELECT Id, Definition.DeveloperName FROM Flow WHERE Id IN (...)                          -- Tooling API
SELECT Id, LogDate, Interval, LogFile FROM EventLogFile
  WHERE EventType = 'ApexUnexpectedException' AND LogDate >= ...
-- sf api request rest <LogFile URL> to download each daily log file
SELECT ApexClass.Name, ApexClass.NamespacePrefix, JobType, ExtendedStatus, CreatedDate, CompletedDate
  FROM AsyncApexJob WHERE CreatedDate >= ... AND (Status = 'Failed' OR NumberOfErrors > 0)
-- sf sobject describe --sobject ssot__AiAgentInteractionStep__dlm, then:
SELECT ssot__Name__c, ssot__TopicApiName__c, ssot__ErrorMessageText__c, <start time>
  FROM ssot__AiAgentInteractionStep__dlm WHERE ssot__ErrorMessageText__c != null AND ...
-- when the suspected components last changed in the org:
SELECT Name, LastModifiedDate FROM ApexClass WHERE NamespacePrefix = null AND Name IN (...)
SELECT Name, LastModifiedDate FROM ApexTrigger WHERE NamespacePrefix = null AND Name IN (...)
SELECT ApiName, LastModifiedDate FROM FlowDefinitionView WHERE ApiName IN (...)
SELECT ValidationName, EntityDefinition.QualifiedApiName, LastModifiedDate FROM ValidationRule
  WHERE ValidationName IN (...)                                                           -- Tooling API
```

### Importing errors

Errors from anywhere else (a logging framework, an observability tool, an Agentforce trace
export) can be added with `--errors errors.json`, and `--errors` works without `--org`:

```json
[
  { "component": { "kind": "Flow", "name": "Opportunity_Set_Defaults", "element": "Set_Default_Probability" },
    "message": "FIELD_CUSTOM_VALIDATION_EXCEPTION: ...", "count": 12,
    "firstSeen": "2026-10-03T08:00:00Z", "lastSeen": "2026-10-05T09:00:00Z" },
  { "component": "ApexClass:ContactTriggerHandler", "exceptionType": "System.LimitException",
    "message": "Too many SOQL queries: 101", "at": "2026-10-05T12:00:00Z" }
]
```

`kind` is `Flow`, `ApexClass`, `ApexTrigger` or `AgentAction`. Each entry needs a time (`at`, or
`firstSeen` and `lastSeen`); entries without one are skipped and counted in the report.

## How errors are traced to changes

Preflight walks the branch's recent history (`--ref`, default `HEAD`), one entry per merged pull
request or pushed commit (first-parent history), looking back `--lookback` days (default 30)
before `--since`, up to `--max-changes` changes (default 50). Each change is analysed component
by component, exactly as `preflight analyze` would, and an error points at a change when:

| Evidence | Example |
|---|---|
| The change touched the failing component, or one in its call stack | It changed Apex class `ContactTriggerHandler`, where the error happens |
| The error is the message of a validation rule the change added or changed, or names a field it changed | It added validation rule `Opportunity.Require_Close_Reason`, and the error is that rule's message |
| The failing component is in the change's blast radius | It changed a validation rule on Opportunity, and the failing flow saves Opportunity records |
| Preflight's findings for the change predicted this kind of failure | A "DML/SOQL in loop" finding and a "Too many SOQL queries" error |

Timing then weighs in. A change merged after the last error is never a suspect; errors that were
already happening before a change was merged count heavily against it. With `--org`, preflight
also reads when the suspected classes, triggers, flows and validation rules last changed in the
org, so it can say the errors started two hours after a rule was deployed, or that the org's
version predates the change (so it may not be deployed there yet).

Each error lists up to three suspects with a confidence (high, medium or low) and the reasons.
Treat them as leads to confirm, not verdicts: an error with no suspect may come from data, from
configuration changed directly in the org, or from a change older than the history checked.

## Partial rollback

`preflight rollback <commit>` plans a rollback of the components you name with `--component`
(by default, everything the commit changed):

| The change | Rollback |
|---|---|
| Changed or deleted a component | Restore its version before the change |
| Added a validation rule | Set `active` to false |
| Added a flow | Set its status to `Obsolete` (or deactivate it in Setup → Flows) |
| Added a trigger | Set its status to `Inactive` |
| Added a field or object | Keep it: deleting it deletes data. Roll back what uses it instead |
| Added an Apex class that something calls | Keep it, and roll back its callers |

A partial rollback has to stay consistent, so preflight brings along what it depends on:

- Restoring a component whose previous version uses something the change deleted or renamed
  restores that too (a class that used a field the change deleted brings the field back).
- Deactivating a new flow restores the changed flows that call it as a subflow.
- Components the rollback leaves alone but that use a restored component are flagged.
- When later commits also changed the files being restored, the plan says so: restoring the
  version before the change undoes them too.

`--restore` applies the plan to your working tree (it refuses to touch files with uncommitted
changes). Nothing is committed or deployed. The plan ends with the commands to ship it the way
any change ships, through a pull request, so the rollback gets the same review, quality gate and
evidence:

```bash
git checkout -b rollback/9c607ea
preflight rollback 9c607ea --component Opportunity.Require_Close_Reason --restore
preflight analyze --base HEAD --gate
sf project deploy validate --target-org prod --source-dir force-app/main/default/objects/Opportunity/validationRules/Require_Close_Reason.validationRule-meta.xml
sf project deploy quick --job-id <id from validate> --target-org prod
```

Coding agents can ask for the same plan through the MCP tool `plan_rollback`.

## Privacy

Error messages often contain record data: names, amounts, record IDs, email addresses. Preflight
classifies each message the moment it reads it and keeps only:

- the kind of failure (for example "A validation rule blocked a save"),
- the exception type and Salesforce status code,
- the validation rule, fields and triggers it names, and only when they exist in the project or
  its history,
- the failing component, counts and times.

The message itself, record IDs and user names are never stored or reported, and the org is named
by its alias, so the report can be posted in a pull request, an incident channel or a ticket.

## Limitations

- Tracing uses the project as it is now to compute each change's blast radius; automation that
  has since been deleted from the repository can't be followed.
- Changes made directly in the org, outside git, can't be traced to a commit.
- Failed flow interviews and the Agentforce source depend on what the org keeps; field names for
  Agentforce session tracing come from Salesforce's published data model (beta).
- Deactivating a flow with status `Obsolete` relies on how your deployment tool handles flow
  versions; deactivating in Setup is always available.
