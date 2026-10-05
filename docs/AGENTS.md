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

## Runtime user

Service agents run as a dedicated user (`botUser` in the bot, `default_agent_user` in Agent
Script); employee agents run as the person using them. What that user needs depends on what the
action calls:

- **Flows** run as the user, so it needs object access for everything the flow saves.
- **Apex** runs in system mode: the user needs access to the Apex class, plus object access only
  when the class enforces user mode (`WITH USER_MODE`, `AccessLevel.USER_MODE`,
  `Security.stripInaccessible`, `WITH SECURITY_ENFORCED`).

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
  chooses the right action for a request (the decision layer) is what Testing Center tests check.
