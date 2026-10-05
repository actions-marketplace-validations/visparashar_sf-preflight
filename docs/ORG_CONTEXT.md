# Org context (`--org`, beta)

By default sf-preflight analyzes your SFDX source offline. With `--org <alias>` it also asks a
Salesforce org a few read-only questions that source code can't answer:

| Question | Why it matters |
|---|---|
| How many records do the impacted objects hold? | Bulk tests should run at a realistic share of real volume, not just 200 rows. |
| Which active flows, triggers and validation rules on those objects exist **in the org but not in the project**? | Preflight can only follow automation it can read. Anything missing from the repo is a blind spot in the cascade. |
| How many active users hold the permission sets or profiles you changed? | A Modify All grant on an unused permission set is a different risk from one held by 400 users or an agent's runtime user. |
| Which packages are installed? | So automation from managed packages is labelled as such. It can't be retrieved as source, but it still runs. |

## Usage

```bash
sf org login web --alias dev          # once, with the Salesforce CLI
preflight analyze --base origin/main --org dev
```

The MCP tool `analyze_change` takes the same option as an `org` argument, and the GitHub Action
takes `sfdx-auth-url` or `org` inputs (see [GITHUB_ACTION.md](GITHUB_ACTION.md#org-context-beta)).

## What it runs

sf-preflight never stores credentials. It calls the Salesforce CLI you already have, as the user
you logged in with:

- `sf org display` to check the org is reachable
- `sf org list sobject record-counts --sobject <impacted objects>`
- `sf data query` with these SOQL queries (some via the Tooling API):

```sql
SELECT QualifiedApiName, DurableId, Label FROM EntityDefinition WHERE QualifiedApiName IN (...)
SELECT ApiName, TriggerType, RecordTriggerType, TriggerObjectOrEventId, TriggerObjectOrEventLabel, NamespacePrefix
  FROM FlowDefinitionView WHERE IsActive = true
SELECT Name, TableEnumOrId, NamespacePrefix, UsageBeforeInsert, UsageAfterInsert, ... FROM ApexTrigger WHERE Status = 'Active'
SELECT ValidationName, EntityDefinitionId, NamespacePrefix FROM ValidationRule WHERE Active = true      -- Tooling API
SELECT SubscriberPackage.NamespacePrefix, SubscriberPackage.Name, ... FROM InstalledSubscriberPackage    -- Tooling API
SELECT Id, Name FROM PermissionSet WHERE IsOwnedByProfile = false AND Name IN (...)                       -- changed permission sets only
SELECT PermissionSetId, COUNT(Id) n FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND ... GROUP BY PermissionSetId
SELECT Id, Name FROM Profile WHERE Name IN (...)                                                          -- changed profiles only
SELECT ProfileId, COUNT(Id) n FROM User WHERE IsActive = true AND ProfileId IN (...) GROUP BY ProfileId
```

Nothing is written to the org. The report contains **only counts and metadata names**, never
record data, user names or org IDs, so it is safe to post as a pull-request comment.

If one query fails, for example because the user lacks a permission, the rest of the context
is still used and the failure is listed in the report. If the org can't be reached at all, the
run stops with an error, because you asked for org context explicitly.

## Permissions

Use a **dedicated, read-only integration user**, ideally in a full or partial-copy sandbox that
mirrors production. It needs:

- **API Enabled**
- **View Setup and Configuration** (flows, triggers, validation rules, packages, assignments)
- Read access to the impacted objects (record counts)

It needs no edit or "Modify All" permissions.

## Limitations

- Permission set counts include **direct** assignments only. Users who get a permission set
  through a permission set group aren't counted yet.
- Standard profiles are matched by their usual names (`Admin` → `System Administrator`, …).
  Renamed standard profiles may not match.
- Up to 100 impacted objects are queried per run.
