# Production change monitor

`preflight monitor` reads a production org's **Setup Audit Trail** and tells you when someone makes a risky
change directly in the org: a validation rule or flow switched off, a broad permission granted, Apex
changed, sharing or security settings touched. Run it on a schedule and it posts to Slack or Teams.

It is read-only: one SOQL query on `SetupAuditTrail` through the `sf` CLI. Nothing is written to the org,
and sf-preflight never stores credentials (it uses an org you authorized with `sf org login`).

```bash
preflight monitor --org prod --since 24h
PREFLIGHT_WEBHOOK_URL=... preflight monitor --org prod --since 1h --notify-on high
```

## What it flags

| Severity | Change |
|---|---|
| high | validation rule deactivated · flow deactivated · Modify All / View All Data, Author Apex, Customize Application, Manage Users granted · Apex class or trigger changed · sharing model changed |
| medium | remote site, named credential, connected app, certificate, IP range, session or password setting · field or object deleted · flow activated · validation rule changed · permission set assigned · profile or permission set changed |

Everything else in the audit trail is read and ignored.

## Options

| Option | Default | Description |
|---|---|---|
| `--org <alias>` | required | Org to watch |
| `--since <when>` | `24h` | Duration (`1h`, `7d`) or a date |
| `--state <file>` | — | Remember the newest change seen so each run reports only new ones. The mark moves forward only after the alert is delivered |
| `--project <dir>` | — | Say whether each change names a component found in the repository (name match) |
| `--ignore-user <names...>` | — | Skip changes by these users, such as your deployment user, so only manual changes are reported. Names are never shown |
| `--notify-on <medium\|high>` | — | Send an alert (webhook from `PREFLIGHT_WEBHOOK_URL`) at this risk or higher |
| `--target`, `--link`, `--dry-run`, `--strict` | | As for [`preflight notify`](GITHUB_ACTION.md#risk-alerts) |
| `--format <md\|json>`, `-o <file>` | `md` | Report format and destination |

## Run it on a schedule

```yaml
name: Production monitor
on:
  schedule: [{ cron: "7 * * * *" }]   # hourly
  workflow_dispatch:
permissions: { contents: read }
jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install --global @salesforce/cli
      - name: Log in (read-only integration user)
        run: |
          echo "$AUTH_URL" > "$RUNNER_TEMP/auth.txt"
          sf org login sfdx-url --sfdx-url-file "$RUNNER_TEMP/auth.txt" --alias prod
          rm "$RUNNER_TEMP/auth.txt"
        env: { AUTH_URL: "${{ secrets.PROD_SFDX_AUTH_URL }}" }
      - run: npx --yes sf-preflight monitor --org prod --since 65m --project . --notify-on high
        env: { PREFLIGHT_WEBHOOK_URL: "${{ secrets.PREFLIGHT_WEBHOOK }}" }
```

The `--since` window is a little longer than the schedule so nothing falls between runs; use `--state`
(with a cache) if you would rather not see a change twice.

## Good to know

- **Permission:** the integration user needs "View Setup and Configuration". The audit trail keeps 180 days.
- **Privacy:** the audit trail names who made each change. That name is read only for `--ignore-user`, and it
  never reaches a report or an alert. Email addresses in entry text are removed. Permission assignments are
  reported without their wording.
- **Accuracy:** entries are matched on the audit trail's own wording and on component names. Salesforce
  words these differently across features, so treat an alert as a prompt to look, not proof, and expect some
  changes to go unnoticed. Open an issue with an example of any you want covered.
- **Row limit:** one query reads up to 2000 entries. The report says when that limit was reached.
