# Sample org fixture

A small, deployable SFDX project used by the test suite. Each component is ordinary Salesforce
metadata, arranged to reproduce failure modes that pass unit tests but break in production.

| Failure mode | Components |
|---|---|
| Validation-rule collision: an invocable action closes deals without the field a rule requires | `OpportunityCloser` (invocable Apex), `Opportunity.Require_Contract_Signed_Date` |
| Cross-object recursion: Account → Contact → Account | roll-up `Account.Total_Won_Amount__c`, flow `Account_Sync_Tier_To_Contacts`, `ContactTrigger` → `ContactTriggerHandler` |
| After-save flow updating its own triggering record | flow `Opportunity_Closed_Won_Followup` |
| SOQL inside a loop | `ContactTriggerHandler` |
| Over-permissioned agent runtime user (Modify All, delete) | permission set `Agent_Runtime_User` |
| Agent action whose saves run into the recursion cycle, untested in Testing Center | `Sales_Agent` (Agent Builder metadata) action `Close_Opportunity` → `OpportunityCloser`; `Service_Agent` (Agent Script) action `Update_Tier` → flow `Update_Customer_Tier` |

The Agentforce metadata (and the two flows only the agents use) is listed in `.forceignore`, so
the project still deploys, and `preflight tests --validate` still works, in orgs without
Agentforce. Preflight analyzes it either way.

Try it:

```bash
npm run build
node dist/cli.js analyze --project fixtures/sample-org \
  --files fixtures/sample-org/force-app/main/default/classes/OpportunityCloser.cls
```
