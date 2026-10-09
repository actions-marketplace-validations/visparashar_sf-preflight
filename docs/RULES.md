# Rules

<!-- Generated from src/core/rules.ts by `npm run docs:rules`. Do not edit by hand. -->

Every finding has a stable rule id. Severity shown is the typical one; some findings are
raised or lowered depending on context (for example, issues in changed code versus code
that is only inside the blast radius).

| Rule | Severity | Summary |
|---|---|---|
| [`recursion-cycle`](#recursion-cycle) | High | Automation writes lead back to an object already being saved in the same transaction. |
| [`automated-write-vs-validation-rule`](#automated-write-vs-validation-rule) | Medium | Automation (or an agent action) writes records that are checked by validation rules. |
| [`field-used-by-validation-rule`](#field-used-by-validation-rule) | Medium | A changed field is referenced by an active validation rule. |
| [`validation-rule-vs-existing-automation`](#validation-rule-vs-existing-automation) | High | A new or changed validation rule applies to existing automation that writes the object. |
| [`after-save-self-update`](#after-save-self-update) | Medium | An after-save flow updates its own triggering record. |
| [`automation-density`](#automation-density) | Medium | Three or more flows/triggers run on the same object and event. |
| [`multiple-triggers`](#multiple-triggers) | Medium | More than one Apex trigger on the same object. |
| [`dml-or-soql-in-loop`](#dml-or-soql-in-loop) | High | DML or SOQL inside a loop in changed Apex or Apex in the blast radius. |
| [`permission-escalation`](#permission-escalation) | High | A permission set or profile grants Modify All or View All on an object. |
| [`permission-system`](#permission-system) | High | A permission set or profile grants a sensitive system permission (e.g. ModifyAllData). |
| [`permission-delete`](#permission-delete) | Medium | A permission set or profile grants delete on an object. |
| [`permission-field-edit`](#permission-field-edit) | Low | A permission set or profile newly grants edit access to fields. |
| [`deleted-still-referenced`](#deleted-still-referenced) | High | A deleted field, flow or class is still referenced elsewhere. |
| [`validation-rule-removed`](#validation-rule-removed) | Info | A validation rule was removed. |
| [`validation-rule-inactive`](#validation-rule-inactive) | Info | A changed validation rule is inactive. |
| [`flow-inactive`](#flow-inactive) | Info | A changed flow is not active. |
| [`org-only-automation`](#org-only-automation) | Medium | Active automation on an impacted object exists in the org (`--org`) but not in the project. |
| [`agent-metadata-changed`](#agent-metadata-changed) | Info | Agentforce metadata changed that no agent action in the project uses. |
| [`agent-action-affected`](#agent-action-affected) | Medium | The change reaches what an agent action calls or saves. |
| [`agent-action-untested`](#agent-action-untested) | Low | No Testing Center test expects an affected agent action. |
| [`agent-action-target-missing`](#agent-action-target-missing) | Low | An affected agent action calls an Apex class or flow that isn't in the project. |
| [`agent-runtime-access`](#agent-runtime-access) | High | With --org: an affected agent's runtime user lacks access its actions need, is inactive or doesn't exist. |
| [`agent-runtime-overprivileged`](#agent-runtime-overprivileged) | Medium | With --org: an affected agent's runtime user holds broad access such as Modify All Data. |
| [`agent-action-no-confirmation`](#agent-action-no-confirmation) | Medium | An agent action deletes records without asking the user for confirmation. |
| [`legacy-workflow`](#legacy-workflow) | Info | A legacy workflow rule changed. |
| [`metadata-not-analyzed`](#metadata-not-analyzed) | Info | A changed component is of a metadata type that is not analyzed in depth. |

## recursion-cycle

**RecursionCycle** · default severity: High

Automation writes lead back to an object already being saved in the same transaction.

Cycles that settle at human pace can recurse, double-apply or hit governor limits at bulk or agent volume. Add recursion guards, narrow entry criteria, or move the write to a before-save flow.

## automated-write-vs-validation-rule

**AutomatedWriteVsValidationRule** · default severity: Medium

Automation (or an agent action) writes records that are checked by validation rules.

A correct action can still fail validation. Make sure the automation sets the fields the rule checks, and that failures are surfaced to the caller instead of swallowed.

## field-used-by-validation-rule

**FieldUsedByValidationRule** · default severity: Medium

A changed field is referenced by an active validation rule.

Changing the field's type, values or how it is populated changes which saves the rule blocks. Test the boundary values.

## validation-rule-vs-existing-automation

**ValidationRuleVsExistingAutomation** · default severity: High

A new or changed validation rule applies to existing automation that writes the object.

Every flow, trigger and class that saves the object must now satisfy the rule. Check each writer sets the required fields.

## after-save-self-update

**AfterSaveSelfUpdate** · default severity: Medium

An after-save flow updates its own triggering record.

This re-runs the whole save procedure. Use a before-save flow for same-record field updates.

## automation-density

**AutomationDensity** · default severity: Medium

Three or more flows/triggers run on the same object and event.

Overlapping automation is where ordering bugs and race conditions hide. Consolidate where possible and set flow trigger order.

## multiple-triggers

**MultipleTriggers** · default severity: Medium

More than one Apex trigger on the same object.

Salesforce does not guarantee the order between triggers on one object. Use one trigger per object with a handler.

## dml-or-soql-in-loop

**DmlOrSoqlInLoop** · default severity: High

DML or SOQL inside a loop in changed Apex or Apex in the blast radius.

Queries and DML inside loops hit governor limits under bulk load. Query and write collections outside the loop.

## permission-escalation

**PermissionEscalation** · default severity: High · security

A permission set or profile grants Modify All or View All on an object.

These bypass sharing for everyone holding the permission, including agent and integration users. Confirm the scope is intended.

## permission-system

**PermissionSystem** · default severity: High · security

A permission set or profile grants a sensitive system permission (e.g. ModifyAllData).

System permissions have org-wide blast radius. Grant them to as few users as possible.

## permission-delete

**PermissionDelete** · default severity: Medium · security

A permission set or profile grants delete on an object.

Delete access is rarely needed by integration or agent users, and deletes cascade through master-detail children.

## permission-field-edit

**PermissionFieldEdit** · default severity: Low · security

A permission set or profile newly grants edit access to fields.

Review that each newly editable field is needed by the users holding the permission.

## deleted-still-referenced

**DeletedStillReferenced** · default severity: High

A deleted field, flow or class is still referenced elsewhere.

The deployment will fail or the references will break at runtime. Remove or update the references in the same change.

## validation-rule-removed

**ValidationRuleRemoved** · default severity: Info

A validation rule was removed.

Data that was previously blocked can now be saved.

## validation-rule-inactive

**ValidationRuleInactive** · default severity: Info

A changed validation rule is inactive.

Inactive rules do not run.

## flow-inactive

**FlowInactive** · default severity: Info

A changed flow is not active.

It will not run until activated.

## org-only-automation

**OrgOnlyAutomation** · default severity: Medium

Active automation on an impacted object exists in the org (`--org`) but not in the project.

Preflight can only follow automation it can read, so the cascade may be incomplete. Retrieve the components into the project; managed-package automation can't be retrieved but still runs, so keep it enabled when testing.

## agent-metadata-changed

**AgentMetadataChanged** · default severity: Info

Agentforce metadata changed that no agent action in the project uses.

Preflight follows agent changes through the actions that use them. Metadata that no agent in the project uses (or that was deleted) can't be followed; check the agents that use it in Agent Builder.

## agent-action-affected

**AgentActionAffected** · default severity: Medium

The change reaches what an agent action calls or saves.

Agents call actions at volume and can't interpret errors the way a person does. Re-run the agent's Testing Center tests, check the action still succeeds with realistic data, and make sure failures are reported back to the agent. High when the action's saves run into an automation cycle.

## agent-action-untested

**AgentActionUntested** · default severity: Low

No Testing Center test expects an affected agent action.

Testing Center checks the decision layer: that the agent picks the right topic and action for a request. Add a test case (an utterance plus the expected topic and action) for every action a change affects.

## agent-action-target-missing

**AgentActionTargetMissing** · default severity: Low

An affected agent action calls an Apex class or flow that isn't in the project.

Preflight can't follow what the action does. Retrieve the class or flow into the project if it only lives in the org.

## agent-runtime-access

**AgentRuntimeAccess** · default severity: High · security

With --org: an affected agent's runtime user lacks access its actions need, is inactive or doesn't exist.

The action fails when the agent runs it. Grant the object access in a permission set assigned to the agent's user, and keep the user active.

## agent-runtime-overprivileged

**AgentRuntimeOverprivileged** · default severity: Medium · security

With --org: an affected agent's runtime user holds broad access such as Modify All Data.

An agent acts on whatever a conversation leads it to. Give its user only the object access its actions need.

## agent-action-no-confirmation

**AgentActionNoConfirmation** · default severity: Medium · security

An agent action deletes records without asking the user for confirmation.

Require confirmation for destructive actions so a misunderstood request can't delete data.

## legacy-workflow

**LegacyWorkflow** · default severity: Info

A legacy workflow rule changed.

Workflow rules are not analyzed yet; consider migrating them to flows.

## metadata-not-analyzed

**MetadataNotAnalyzed** · default severity: Info

A changed component is of a metadata type that is not analyzed in depth.

sf-preflight recognizes the type (layouts, Lightning components, page layouts, labels, ...) but only lists it and the files that mention it. Review what depends on it yourself, and turn the rule off in .preflight.json if the noise is not useful.
