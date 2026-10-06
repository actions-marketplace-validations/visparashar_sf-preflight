# Agentforce agents

Agentforce agents act through **actions**: Apex classes, flows and prompt templates that the
agent chooses based on a conversation. A change to a field, a validation rule, a flow or a class
can break an agent action without anyone touching the agent, and agents can't interpret errors the
way a person does.

sf-preflight reads your agents from source and, for every change, answers:

- **Which agent actions does this change reach?** Through the class or flow each action calls,
  and the save procedures (triggers, flows, validation rules, roll-ups) that follow.
- **Do Testing Center tests cover them?** Which tests expect each affected action.
- **Can the agent's user run them?** What access the runtime user needs, and with `--org`,
  whether it has that access and nothing broader.

```bash
preflight analyze --base origin/main      # agent findings and an "Agent actions" table
preflight agents                          # list the agents in the project
preflight agents Sales_Agent              # what each action calls, saves, needs and is tested by
preflight agent-tests --base origin/main --org my-sandbox   # run the Testing Center tests that cover the change
```

## What it reads

Both ways of defining agents in SFDX source are supported:

| Source | Files |
|---|---|
| Agent Builder metadata | `bots/<Agent>/<Agent>.bot-meta.xml` and `v*.botVersion-meta.xml`, `genAiPlannerBundles/` (or `genAiPlanners/`), `genAiPlugins/` (topics), `genAiFunctions/` (actions) |
| Agent Script | `aiAuthoringBundles/<Agent>/<Agent>.agent`: topics or subagents, and actions with `target: "apex://…"`, `"flow://…"` or `"prompt://…"` |
| Testing Center | `aiEvaluationDefinitions/*.aiEvaluationDefinition-meta.xml` and `aiTestingDefinitions/*.aiTestingDefinition-meta.xml`: the topics and actions each test case expects |

Retrieve them with `sf project retrieve start --metadata Bot GenAiPlannerBundle GenAiPlugin
GenAiFunction AiAuthoringBundle AiEvaluationDefinition`.

## Findings

| Rule | Severity | When |
|---|---|---|
| [`agent-action-affected`](RULES.md#agent-action-affected) | medium, high | The change reaches what an action calls or saves. High when the action's saves run into an automation cycle. |
| [`agent-action-untested`](RULES.md#agent-action-untested) | low | No Testing Center test case expects an affected action. |
| [`agent-action-no-confirmation`](RULES.md#agent-action-no-confirmation) | medium | An affected action deletes records without asking the user to confirm. |
| [`agent-action-target-missing`](RULES.md#agent-action-target-missing) | low | An affected action calls a class or flow that isn't in the project. |
| [`deleted-still-referenced`](RULES.md#deleted-still-referenced) | high | An action calls a class or flow the change deletes. |
| [`agent-runtime-access`](RULES.md#agent-runtime-access) | high | With `--org`: the runtime user lacks access the actions need, is inactive or doesn't exist. |
| [`agent-runtime-overprivileged`](RULES.md#agent-runtime-overprivileged) | medium | With `--org`: the runtime user holds Modify All Data, View All Data or Modify All on an object the actions use. |

A finding names the agent, topic and action, and says why the change reaches it, for example:

> **Agent action Close Opportunity (Sales Agent › Close Deals) is affected.** The action calls
> class OpportunityCloser. Affected by: changed field Opportunity.Contract_Signed_Date__c, which
> applies when the action saves Opportunity. When it runs, it saves Account, Contact, Opportunity,
> Task. Its saves run into an automation cycle (Opportunity → Opportunity), which agents can
> trigger far more often than people.

Changing agent metadata itself (an action, topic, planner, bot or Agent Script file) roots the
cascade at what its actions save, so the usual findings (recursion, validation rules, DML in
loops) apply to the agent's actions too.

The report's **Agent actions** table lists each affected action with what it calls, what it
saves, what its runtime user needs and its Testing Center coverage. The suggested tests include
the `sf agent test run` commands for tests that cover affected actions, and test cases to add for
those no test covers.

## Running Testing Center tests

Testing Center checks the agent as deployed in an org, so deploy the change to a sandbox (or
scratch org, or Developer Edition org) first, then:

```bash
preflight agent-tests --base origin/main --dry-run                  # which tests cover the change
preflight agent-tests --base origin/main --org my-sandbox           # run them and report each case
preflight agent-tests --base origin/main --org my-sandbox --format json > agent-tests.json
```

Preflight picks the tests of affected agents that expect an affected action, or the topic it
belongs to, and runs each with `sf agent test run` (Testing Center and Agentforce Studio tests
both work). `--all` runs every test of the affected agents; `--test <names...>` runs the tests you
name. The report shows each test, how many cases passed and, for the rest, which expectation
didn't match:

```markdown
### Testing Center in my-sandbox

❌ 1 of 1 test run(s) didn't pass.

| Test | Agent | Result | Cases passed | Details |
|---|---|---|---|---|
| `Sales_Agent_Tests` | Sales_Agent | ❌ failed | 2/3 | #3 "Close the Acme deal": action_sequence_match: expected ['Close_Opportunity'], got ['Log_Customer_Call'] |
```

It exits with code 2 when a test fails. A test still running after `--wait` minutes (default 10)
is reported with the command to check it later.

Agent actions really run during a test: they can create and update records. Preflight refuses
production orgs (and orgs it can't identify) unless you pass `--allow-production`.

To make passing tests part of the [quality gate](CONFIG.md#quality-gate), set
`requireAgentTestsPassed` and pass the JSON output with `--agent-tests-result`. The gate fails
when a test that covers the change isn't in the result, so a result from another change or a
narrower run doesn't count. The [evidence pack](EVIDENCE.md) records each run.

## Runtime user

Service agents run as a dedicated user (`botUser` in the bot, `default_agent_user` in Agent
Script). Employee agents (bot type `InternalCopilot`, or an employee agent type) run as the person
using them, even when a default user is named. What the user needs depends on what the action
calls:

- **Flows** run as the user unless set to run in system mode, so the user needs object access
  for everything the flow and its subflows save (Apex actions inside the flow run in system mode).
- **Apex** runs in system mode: the user needs access to the Apex class, plus object access only
  when the code saves in user mode (`update as user records;` or `AccessLevel.USER_MODE`).

Without an org, preflight lists these needs. With `--org`, it checks the user's effective access
from its permission set assignments (including its profile), and whether it can run the Apex
classes. The runtime user is only ever referred to as "<agent>'s runtime user"; its username is
used in one query and never appears in a report.

## Limitations

- Topic and action references are resolved within the project. Standard actions and actions from
  managed packages appear with their type but can't be followed.
- Testing Center coverage matches expected actions by API name. A test that expects only a topic
  doesn't count as covering the topic's actions.
- Preflight checks what an action does when it runs (the execution layer). Whether the agent
  chooses the right action for a request (the decision layer) is what Testing Center tests check;
  `preflight agent-tests` runs them, but the results reflect what's deployed in the org.
