# sf-plugin-preflight

Salesforce CLI plugin for [sf-preflight](https://github.com/visparashar/sf-preflight): see what a
Salesforce change sets off (flows, triggers, validation rules, roll-ups, permissions, Agentforce
actions) before it ships. It adds an `sf preflight` topic.

The plugin has no analysis of its own. Each command passes your flags to the `sf-preflight` CLI it
depends on, so `sf preflight analyze` and `npx sf-preflight analyze` always give the same answer.

## Install

```sh
sf plugins install sf-plugin-preflight
```

`sf` asks you to confirm because the plugin is not on Salesforce's signed list. To skip the prompt,
add it to `~/.config/sf/unsignedPluginAllowList.json`. Needs Node 22.13 or later.

## Use

```sh
sf preflight analyze --base origin/main            # what does this branch set off?
sf preflight analyze --base origin/main --gate     # exit 2 if the quality gate fails
sf preflight analyze --base origin/main --json     # same as --format json
sf preflight tests --base origin/main --validate --target-org my-sandbox
sf preflight agents Sales_Agent
sf preflight incidents --target-org prod --since 7d
sf preflight rollback a1b2c3d
sf preflight explain Opportunity
sf preflight evidence --base origin/main --out preflight-evidence.json
```

Run `sf preflight <command> --help` for the common flags. Every flag of the sf-preflight CLI works,
listed or not (for example `--md-out`, `--sarif-out`, `--config`); see the
[CLI reference](https://github.com/visparashar/sf-preflight#readme).

## How sf's flags map

| You type | The CLI receives |
|---|---|
| `-o <org>`, `--target-org <org>` | `--org <org>` |
| `--json` | `--format json` (commands without formats ignore it) |

On commands that read an org (`analyze`, `tests`, `agent-tests`, `incidents`, `rollback`), `-o` is
the org, as everywhere in `sf`. The CLI's own output file flag is spelled `--out` there. On
`evidence` and `explain`, which never read an org, `-o` stays the CLI's `--out`.

## Safety

Same as the CLI. Nothing is deployed. Org commands are read-only, except `tests --validate` (a
check-only deployment, nothing saved) and `agent-tests` (runs existing Testing Center tests); both
refuse a production org unless you pass `--allow-production`. Reports never contain usernames or
record data. The plugin never reads or stores credentials: your org is reached through `sf` itself.

## Development

```sh
npm ci && npm run build          # in the repository root
cd sf-plugin && npm ci && npm test
SF_PREFLIGHT_CLI=../dist/cli.js node test/run.mjs preflight analyze --help
```

`SF_PREFLIGHT_CLI` points the plugin at a local build instead of the installed dependency.

Apache-2.0.
