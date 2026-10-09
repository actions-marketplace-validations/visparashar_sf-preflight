// SPDX-License-Identifier: Apache-2.0
import type { Severity } from "./types.js";

/**
 * Catalog of finding rules. Used for SARIF rule metadata and docs/RULES.md.
 * Rule ids are stable: never rename one, deprecate it instead.
 */
export interface RuleInfo {
  id: string;
  name: string;
  /** Typical severity; individual findings may differ (e.g. changed vs impacted code). */
  defaultSeverity: Severity;
  summary: string;
  /** Why it matters and what to do about it. */
  help: string;
  security?: boolean;
}

export const RULES: RuleInfo[] = [
  {
    id: "recursion-cycle",
    name: "RecursionCycle",
    defaultSeverity: "high",
    summary: "Automation writes lead back to an object already being saved in the same transaction.",
    help: "Cycles that settle at human pace can recurse, double-apply or hit governor limits at bulk or agent volume. Add recursion guards, narrow entry criteria, or move the write to a before-save flow.",
  },
  {
    id: "automated-write-vs-validation-rule",
    name: "AutomatedWriteVsValidationRule",
    defaultSeverity: "medium",
    summary: "Automation (or an agent action) writes records that are checked by validation rules.",
    help: "A correct action can still fail validation. Make sure the automation sets the fields the rule checks, and that failures are surfaced to the caller instead of swallowed.",
  },
  {
    id: "field-used-by-validation-rule",
    name: "FieldUsedByValidationRule",
    defaultSeverity: "medium",
    summary: "A changed field is referenced by an active validation rule.",
    help: "Changing the field's type, values or how it is populated changes which saves the rule blocks. Test the boundary values.",
  },
  {
    id: "validation-rule-vs-existing-automation",
    name: "ValidationRuleVsExistingAutomation",
    defaultSeverity: "high",
    summary: "A new or changed validation rule applies to existing automation that writes the object.",
    help: "Every flow, trigger and class that saves the object must now satisfy the rule. Check each writer sets the required fields.",
  },
  {
    id: "after-save-self-update",
    name: "AfterSaveSelfUpdate",
    defaultSeverity: "medium",
    summary: "An after-save flow updates its own triggering record.",
    help: "This re-runs the whole save procedure. Use a before-save flow for same-record field updates.",
  },
  {
    id: "automation-density",
    name: "AutomationDensity",
    defaultSeverity: "medium",
    summary: "Three or more flows/triggers run on the same object and event.",
    help: "Overlapping automation is where ordering bugs and race conditions hide. Consolidate where possible and set flow trigger order.",
  },
  {
    id: "multiple-triggers",
    name: "MultipleTriggers",
    defaultSeverity: "medium",
    summary: "More than one Apex trigger on the same object.",
    help: "Salesforce does not guarantee the order between triggers on one object. Use one trigger per object with a handler.",
  },
  {
    id: "dml-or-soql-in-loop",
    name: "DmlOrSoqlInLoop",
    defaultSeverity: "high",
    summary: "DML or SOQL inside a loop in changed Apex or Apex in the blast radius.",
    help: "Queries and DML inside loops hit governor limits under bulk load. Query and write collections outside the loop.",
  },
  {
    id: "permission-escalation",
    name: "PermissionEscalation",
    defaultSeverity: "high",
    summary: "A permission set or profile grants Modify All or View All on an object.",
    help: "These bypass sharing for everyone holding the permission, including agent and integration users. Confirm the scope is intended.",
    security: true,
  },
  {
    id: "permission-system",
    name: "PermissionSystem",
    defaultSeverity: "high",
    summary: "A permission set or profile grants a sensitive system permission (e.g. ModifyAllData).",
    help: "System permissions have org-wide blast radius. Grant them to as few users as possible.",
    security: true,
  },
  {
    id: "permission-delete",
    name: "PermissionDelete",
    defaultSeverity: "medium",
    summary: "A permission set or profile grants delete on an object.",
    help: "Delete access is rarely needed by integration or agent users, and deletes cascade through master-detail children.",
    security: true,
  },
  {
    id: "permission-field-edit",
    name: "PermissionFieldEdit",
    defaultSeverity: "low",
    summary: "A permission set or profile newly grants edit access to fields.",
    help: "Review that each newly editable field is needed by the users holding the permission.",
    security: true,
  },
  {
    id: "deleted-still-referenced",
    name: "DeletedStillReferenced",
    defaultSeverity: "high",
    summary: "A deleted field, flow or class is still referenced elsewhere.",
    help: "The deployment will fail or the references will break at runtime. Remove or update the references in the same change.",
  },
  {
    id: "validation-rule-removed",
    name: "ValidationRuleRemoved",
    defaultSeverity: "info",
    summary: "A validation rule was removed.",
    help: "Data that was previously blocked can now be saved.",
  },
  {
    id: "validation-rule-inactive",
    name: "ValidationRuleInactive",
    defaultSeverity: "info",
    summary: "A changed validation rule is inactive.",
    help: "Inactive rules do not run.",
  },
  {
    id: "flow-inactive",
    name: "FlowInactive",
    defaultSeverity: "info",
    summary: "A changed flow is not active.",
    help: "It will not run until activated.",
  },
  {
    id: "org-only-automation",
    name: "OrgOnlyAutomation",
    defaultSeverity: "medium",
    summary: "Active automation on an impacted object exists in the org (`--org`) but not in the project.",
    help: "Preflight can only follow automation it can read, so the cascade may be incomplete. Retrieve the components into the project; managed-package automation can't be retrieved but still runs, so keep it enabled when testing.",
  },
  {
    id: "agent-metadata-changed",
    name: "AgentMetadataChanged",
    defaultSeverity: "info",
    summary: "Agentforce metadata changed that no agent action in the project uses.",
    help: "Preflight follows agent changes through the actions that use them. Metadata that no agent in the project uses (or that was deleted) can't be followed; check the agents that use it in Agent Builder.",
  },
  {
    id: "agent-action-affected",
    name: "AgentActionAffected",
    defaultSeverity: "medium",
    summary: "The change reaches what an agent action calls or saves.",
    help: "Agents call actions at volume and can't interpret errors the way a person does. Re-run the agent's Testing Center tests, check the action still succeeds with realistic data, and make sure failures are reported back to the agent. High when the action's saves run into an automation cycle.",
  },
  {
    id: "agent-action-untested",
    name: "AgentActionUntested",
    defaultSeverity: "low",
    summary: "No Testing Center test expects an affected agent action.",
    help: "Testing Center checks the decision layer: that the agent picks the right topic and action for a request. Add a test case (an utterance plus the expected topic and action) for every action a change affects.",
  },
  {
    id: "agent-action-target-missing",
    name: "AgentActionTargetMissing",
    defaultSeverity: "low",
    summary: "An affected agent action calls an Apex class or flow that isn't in the project.",
    help: "Preflight can't follow what the action does. Retrieve the class or flow into the project if it only lives in the org.",
  },
  {
    id: "agent-runtime-access",
    name: "AgentRuntimeAccess",
    defaultSeverity: "high",
    summary:
      "With --org: an affected agent's runtime user lacks access its actions need, is inactive or doesn't exist.",
    help: "The action fails when the agent runs it. Grant the object access in a permission set assigned to the agent's user, and keep the user active.",
    security: true,
  },
  {
    id: "agent-runtime-overprivileged",
    name: "AgentRuntimeOverprivileged",
    defaultSeverity: "medium",
    summary: "With --org: an affected agent's runtime user holds broad access such as Modify All Data.",
    help: "An agent acts on whatever a conversation leads it to. Give its user only the object access its actions need.",
    security: true,
  },
  {
    id: "agent-action-no-confirmation",
    name: "AgentActionNoConfirmation",
    defaultSeverity: "medium",
    summary: "An agent action deletes records without asking the user for confirmation.",
    help: "Require confirmation for destructive actions so a misunderstood request can't delete data.",
    security: true,
  },
  {
    id: "legacy-workflow",
    name: "LegacyWorkflow",
    defaultSeverity: "info",
    summary: "A legacy workflow rule changed.",
    help: "Workflow rules are not analyzed yet; consider migrating them to flows.",
  },
  {
    id: "field-used-by-lightning",
    name: "FieldUsedByLightning",
    defaultSeverity: "low",
    summary: "A changed field is used by Lightning Web Components or Aura components.",
    help: "Components read and show the field directly. After changing its type, values or access, check the component and the pages it sits on.",
  },
  {
    id: "apex-called-from-lightning",
    name: "ApexCalledFromLightning",
    defaultSeverity: "low",
    summary: "A changed Apex class is called from Lightning components.",
    help: "Lightning components call Apex from the browser, so a changed signature, result shape or error behaviour reaches users without a flow or trigger in between. Re-test the component.",
  },
  {
    id: "lightning-missing-reference",
    name: "LightningMissingReference",
    defaultSeverity: "medium",
    summary: "A changed Lightning component uses a field or Apex class that is not in the project.",
    help: "Importing a missing field or class fails the deployment. Add it to the project, or make sure it exists in the target org before this change deploys.",
  },
  {
    id: "field-on-page",
    name: "FieldOnPage",
    defaultSeverity: "info",
    summary: "A changed field is on page layouts or Lightning pages.",
    help: "A changed label, type or access shows up on those pages. Open one to check it still reads well.",
  },
  {
    id: "lightning-on-page",
    name: "LightningOnPage",
    defaultSeverity: "info",
    summary: "A changed Lightning component is placed on Lightning pages.",
    help: "Open the pages to check the component renders and behaves as intended where it is placed.",
  },
  {
    id: "page-missing-reference",
    name: "PageMissingReference",
    defaultSeverity: "medium",
    summary: "A changed layout or Lightning page uses a field or component that is not in the project.",
    help: "A page that names a missing field or component fails the deployment. Add it to the project, or make sure the target org already has it.",
  },
  {
    id: "page-element-removed",
    name: "PageElementRemoved",
    defaultSeverity: "low",
    summary: "A changed layout or Lightning page no longer shows fields or components it showed before.",
    help: "Users of the page lose them. Confirm that is intended, and that nothing in their process depends on seeing them.",
  },
  {
    id: "metadata-not-analyzed",
    name: "MetadataNotAnalyzed",
    defaultSeverity: "info",
    summary: "A changed component is of a metadata type that is not analyzed in depth.",
    help: "sf-preflight recognizes the type (layouts, Lightning components, page layouts, labels, ...) but only lists it and the files that mention it. Review what depends on it yourself, and turn the rule off in .preflight.json if the noise is not useful.",
  },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function ruleInfo(id: string): RuleInfo | undefined {
  return BY_ID.get(id);
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low", info: "Info" };

/** Render docs/RULES.md from the catalog (kept in sync by a test). */
export function renderRulesMarkdown(): string {
  const lines = [
    "# Rules",
    "",
    "<!-- Generated from src/core/rules.ts by `npm run docs:rules`. Do not edit by hand. -->",
    "",
    "Every finding has a stable rule id. Severity shown is the typical one; some findings are",
    "raised or lowered depending on context (for example, issues in changed code versus code",
    "that is only inside the blast radius).",
    "",
    "| Rule | Severity | Summary |",
    "|---|---|---|",
    ...RULES.map((r) => `| [\`${r.id}\`](#${r.id}) | ${SEVERITY_LABEL[r.defaultSeverity]} | ${r.summary} |`),
    "",
  ];
  for (const r of RULES) {
    lines.push(
      `## ${r.id}`,
      "",
      `**${r.name}** · default severity: ${SEVERITY_LABEL[r.defaultSeverity]}${r.security ? " · security" : ""}`,
      "",
      r.summary,
      "",
      r.help,
      "",
    );
  }
  return lines.join("\n");
}
