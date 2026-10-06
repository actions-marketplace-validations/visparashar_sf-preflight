# Production errors and partial rollback

Use this when the user reports failures in production (failed flows, Apex exceptions, failed
jobs, Agentforce action errors), usually after a recent deployment.

## 1. Trace the errors

```bash
npx -y sf-preflight incidents --org <alias> --since 24h --ref origin/main
```

- Read-only, so it's safe on production. The user's org alias comes from `sf org list`; never
  ask for credentials.
- Without org access, errors exported from elsewhere can be passed as JSON:
  `--errors errors.json` (a list of `{ "component": "ApexClass:Name", "message": "...", "at": "2026-10-05T12:00:00Z" }`).
- The report groups errors, names where each happens, and lists up to three suspect changes per
  error with a confidence and the reasons. Treat suspects as leads to confirm, not verdicts; an
  error with no suspect may come from data or from configuration changed directly in the org.
- Notes such as "errors after … aren't in the event log yet" mean the data is incomplete: say so.

## 2. Plan a partial rollback

For a suspect with high confidence, the report suggests a command such as:

```bash
npx -y sf-preflight rollback 9c607ea --component ValidationRule:Opportunity.Require_Close_Reason
```

(MCP: `plan_rollback` with `commit` and `components`.) The plan restores or deactivates only the
components involved, plus what keeps the result consistent, and lists warnings: later commits it
would undo, fields or objects to undelete or rename back in Setup (never redeployed empty),
callers of a flow it deactivates, files `.forceignore` would skip. Show the user the plan and the
warnings before changing anything.

## 3. Apply it as a pull request

Only when the user agrees:

```bash
git checkout -b rollback/9c607ea
npx -y sf-preflight rollback 9c607ea --component ValidationRule:Opportunity.Require_Close_Reason --restore
npx -y sf-preflight analyze --base HEAD --gate
```

`--restore` edits local files only (nothing staged, committed or deployed) and refuses files with
uncommitted changes. Commit, open a pull request, and let the user's pipeline deploy it. Do any
Setup steps the plan lists (undelete a field, activate a flow version) only by telling the user;
don't deploy yourself.

## Agentforce tests after a fix

Once a change is deployed to a sandbox, `npx -y sf-preflight agent-tests --base origin/main --org <sandbox>`
runs the Testing Center tests that cover the affected agent actions. It refuses production orgs.
