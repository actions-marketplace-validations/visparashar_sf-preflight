# Changelog

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
