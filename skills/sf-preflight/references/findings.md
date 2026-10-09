# Acting on findings

Each finding has a `rule`, a `severity` and the files involved. Fix the cause, not the report:
don't disable a rule or edit `.preflight.json` to make a finding go away unless the user asks.

| Rule | Severity | What it means | Usual fix |
|---|---|---|---|
| `recursion-cycle` | High | Automation writes lead back to an object already being saved in the same transaction. | Add a recursion guard (static set of processed IDs), narrow flow entry criteria to the fields that matter, or move the write to an async path. |
| `dml-or-soql-in-loop` | High | DML or SOQL inside a loop, which hits governor limits in bulk. | Collect records/IDs in the loop, query and save once outside it. |
| `validation-rule-vs-existing-automation` | High | A new or changed validation rule applies to automation that already writes the object; those saves can now fail. | Make the automation set the required values, or exempt it in the rule's formula; add a test that runs the automation against the rule. |
| `deleted-still-referenced` | High | A deleted field, flow or class is still used elsewhere. | Remove or update the references in the same change, or don't delete it yet. |
| `permission-escalation` | High | Modify All or View All granted on an object. | Grant only the object/field access needed; confirm with the user if broad access is intended. |
| `permission-system` | High | A sensitive system permission (e.g. Modify All Data) is granted. | Remove it unless the user confirms it's required. |
| `agent-runtime-access` | High | With `--org`: an agent's runtime user lacks access its actions need, or is inactive. | Grant the missing object access or Apex class access through a permission set assigned to that user. |
| `automated-write-vs-validation-rule` | Medium | Automation or an agent action writes records that validation rules check. | Make sure the written values satisfy the rules; test the save path. |
| `field-used-by-validation-rule` | Medium | A changed field is used by an active validation rule. | Check the rule still behaves with the field's new type, values or meaning. |
| `after-save-self-update` | Medium | An after-save flow updates its own triggering record (re-runs the save). | Use a before-save flow for same-record updates. |
| `automation-density` | Medium | Three or more flows/triggers run on the same object and event. | Consider consolidating; order and interaction become hard to reason about. |
| `multiple-triggers` | Medium | More than one Apex trigger on an object (order isn't guaranteed). | Consolidate into one trigger with a handler. |
| `permission-delete` | Medium | Delete access granted on an object. | Confirm it's intended. |
| `org-only-automation` | Medium | With `--org`: active automation on an impacted object exists in the org but not in the project. | Retrieve it into the project so the analysis (and review) sees it. |
| `agent-action-affected` | Medium | The change reaches what an Agentforce action calls or saves. | Re-run the agent's Testing Center tests; check the action still succeeds with realistic data. |
| `agent-runtime-overprivileged` | Medium | With `--org`: an agent's runtime user has broad access. | Reduce it to what the actions need. |
| `agent-action-no-confirmation` | Medium | An agent action deletes records without asking for confirmation. | Require confirmation on the action. |
| `permission-field-edit` | Low | Edit access newly granted to fields. | Confirm it's intended. |
| `agent-action-untested` | Low | No Testing Center test expects an affected agent action. | Add a test case (utterance plus expected topic and action). |
| `agent-action-target-missing` | Low | An agent action calls an Apex class or flow that isn't in the project. | Retrieve it, or check the reference. |
| `validation-rule-removed`, `validation-rule-inactive`, `flow-inactive`, `agent-metadata-changed`, `legacy-workflow` | Info | Context worth mentioning in your summary. | Usually nothing to fix. |
| `field-used-by-lightning`, `apex-called-from-lightning` | Low | Lightning Web Components or Aura components use the changed field, or call the changed Apex class from the browser. | Re-test those components and the pages they sit on. |
| `lightning-missing-reference` | Medium | A changed Lightning component imports a field or Apex class that is not in the project. | Add it to the project, or make sure the target org already has it. |
| `picklist-value-removed` | Medium | Picklist values were removed or deactivated while record types, formulas, flows or Apex still use them (Low if nothing does). | Remove them from the record types and replace them in the code, or keep them active. |
| `record-type-values-removed`, `record-type-deactivated` | Low | A record type no longer offers picklist values, or was deactivated. | Check who creates or edits records of that type. |
| `record-type-still-referenced` | Medium | A deleted record type is still named in Apex, flows or formulas. | Update what names it; the comparison will quietly stop matching. |
| `field-on-page`, `lightning-on-page` | Info | A changed field is on layouts or Lightning pages, or a changed component is placed on Lightning pages. | Open one of the pages to check it still reads and behaves well. |
| `page-missing-reference` | Medium | A changed layout or Lightning page names a field or component that is not in the project. | Add it to the project, or make sure the target org already has it. |
| `page-element-removed` | Low | A changed layout or Lightning page no longer shows fields or components it did before. | Confirm that is intended. |
| `metadata-not-analyzed` | Info | A changed component is of a metadata type sf-preflight only lists (layout, Lightning component, flexipage, label, ...). The report shows which project files mention it. | Check those files yourself: the analysis did not cover what this change affects. |

Full explanations: https://github.com/visparashar/sf-preflight/blob/main/docs/RULES.md
