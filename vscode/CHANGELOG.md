# Changelog

## [0.2.0]

- **Blast radius graph**: the change at the centre and what it sets off around it, one ring per
  hop: the objects it saves, the flows, triggers, validation rules and roll-ups that run, what
  references it, and the Agentforce actions it reaches. Nodes are coloured by their worst finding
  (impacted, collision, high risk), automation cycles are drawn as recursion arrows, and hovering
  a node lists its findings. Click a node to open its file. Opens from the graph button on the
  Blast radius view, the risk line in it, or **sf-preflight: Show blast-radius graph**, and
  follows every re-analysis. Several changes gather round a hub. Large graphs keep the 80
  nearest and riskiest nodes.

## [0.1.0]

First release.

- Findings in the Problems panel on the files they're about, linked to the rule's explanation.
- The **Blast radius** view: risk, findings, changed components, what runs on each impacted object
  in order of execution, automation cycles and affected Agentforce actions.
- Analyzes again a moment after Salesforce metadata changes (saves, branch switches, pulls,
  retrieves), one run per project at a time and at most two projects at once; compares with your
  default branch from where your branch left it, or a branch you choose per workspace folder.
- Commands: show the full report, explain what runs when an object is saved, generate Apex tests
  for the change, install the agent skill.
- Offers the sf-preflight MCP server to agent mode (GitHub Copilot and other agents) in editors
  that support MCP server providers (VS Code 1.101+).
- Needs a trusted workspace. Writes generated tests and the agent skill only inside the project,
  never through symbolic links. Ships the licences of the libraries it bundles.
