# Using sf-preflight from coding agents (MCP)

`preflight mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio. Coding agents such as Claude Code, Cursor, VS Code agents and other MCP clients can then
check their own Salesforce changes before committing or deploying them.

The server is **read-only**: it reads SFDX source and runs `git diff`/`git log`. It never
deploys, writes files or contacts a Salesforce org.

## Tools

| Tool | What it does | Key arguments |
|---|---|---|
| `analyze_change` | Full preflight report for a change: cascade, findings, suggested tests | `base` (default `HEAD`), `head`, `files`, `format` (`markdown`/`json`), `project_dir`, `max_depth`, `org` (beta, see [ORG_CONTEXT.md](ORG_CONTEXT.md)) |
| `explain_save_order` | What runs, in order, when an object is saved | `object`, `event` (`insert`/`update`/`delete`/`undelete`), `project_dir` |
| `find_field_references` | Validation rules, flows, Apex, formulas, roll-ups and permission sets that use a field | `object`, `field`, `project_dir` |
| `generate_tests` | Apex tests for what a change touches (bulk, recursion, idempotency, validation errors surfacing), returned as code; nothing is written to disk. See [TESTS.md](TESTS.md) | `base` (default `HEAD`), `head`, `files`, `project_dir`, `prefix`, `bulk_size` |

With no arguments, `analyze_change` compares the working tree (including untracked files) with
`HEAD`, which is exactly "what has the agent changed so far?".

The server also sends instructions telling the agent when to call each tool: after editing
metadata, before adding automation to an object, and before renaming or deleting a field.

## Setup

Requires Node.js 22.13+. The server analyzes the directory it is started in; pass
`--root <dir>` to choose another one. Tool calls cannot reach outside that root.

### Claude Code

```bash
claude mcp add sf-preflight -- npx -y sf-preflight mcp
```

### Cursor

`.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "sf-preflight": {
      "command": "npx",
      "args": ["-y", "sf-preflight", "mcp"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "sf-preflight": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-preflight", "mcp"]
    }
  }
}
```

### Other MCP clients

Any client that can launch a stdio server works. Command `npx`, arguments
`-y sf-preflight mcp`. If your project lives in a subdirectory, either start the client there
or add `--root path/to/project`.

## Example agent workflow

1. The agent edits a flow and an Apex class.
2. It calls `analyze_change` and sees a validation-rule collision and a recursion cycle.
3. It fixes the flow's entry criteria, adds a recursion guard, and calls `generate_tests` to
   add bulk, recursion and validation-error tests for the change to the project.
4. It calls `analyze_change` again before committing, and reports any remaining findings to
   you with an explanation.

Pair this with the [GitHub Action](GITHUB_ACTION.md) so the same checks run on the pull
request, whether the change was written by a person or an agent.
