# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Test generation:** `preflight tests` writes Apex tests for what a change touches: bulk saves
  of 200 records for each affected object and event, recursion along cross-object automation
  cycles, idempotency of after-save flows that update their own record and create related
  records, and invocable actions surfacing (not swallowing) validation errors. Tests use a
  generated, describe-driven data factory (`PreflightDataFactory`) that fills required fields at
  run time; the values a test needs are solved from flow entry criteria and validation-rule
  formulas. Anything not generated is listed with the reason, and the summary prints the
  check-only `sf project deploy validate` command to run them. See
  [docs/TESTS.md](docs/TESTS.md).
- MCP tool `generate_tests` returns the same tests as code for coding agents (read-only; nothing
  is written to disk).
- `runTests()` and `generateTests()` in the library API.
- Flow parsing now keeps start-condition values, filter logic, formulas and "only when updated to
  meet the criteria"; the field a flow uses to link records it creates or updates to the
  triggering record; Apex method parameter types and `static`; and custom field `required` and
  default values.

## [0.2.0] - 2026-10-05

Accurate Apex analysis on a real parse tree, and read-only org context (beta).
**Requires Node.js 22.13 or newer.**

### Changed

- Apex is now analyzed on a real parse tree using
  [@apexdevtools/apex-parser](https://github.com/apex-dev-tools/apex-parser) instead of regular
  expressions. DML targets resolve through parameters, for-each variables, class fields and
  properties, casts and same-class method return types. Files with syntax errors fall back to
  the previous heuristics and are listed in the warnings.
- Field references in Apex are matched precisely by object, including standard fields and SOQL
  relationship paths, so `find_field_references` and the "deleted but still referenced" check
  have fewer false positives.
- Requires Node.js 22.13 or newer (required by the Apex parser).

### Added

- DML and SOQL inside helper methods called from a loop are now found, across classes (for
  example a trigger handler loop calling `AccountRepo.touch()` which runs a query). The finding
  names the method that does the work.
- `EventBus.publish` is treated as an insert of the platform event, so event-triggered
  automation joins the cascade.
- **Org context (beta):** `preflight analyze --org <alias>` adds read-only context from an
  org authorized with the Salesforce CLI. It reports record volumes for impacted objects
  (used in bulk test suggestions), active flows/triggers/validation rules that exist in the
  org but not in the project (new `org-only-automation` rule), how many active users hold
  changed permission sets and profiles, and installed packages. Each org-only finding says
  how the change reaches that automation and gives the `sf project retrieve start` command to
  pull it in; automation that never fires for the events reached is left out. Reports contain
  only counts and metadata names: a username passed to `--org` is shown as the org's alias
  (or "target org"). Also available as the MCP `org` argument and the action's
  `sfdx-auth-url` / `org` inputs. See [docs/ORG_CONTEXT.md](docs/ORG_CONTEXT.md).

### Fixed

- Piping output into a command that exits early (for example `preflight analyze | head`) no
  longer crashes with an `EPIPE` error.

## [0.1.0] - 2026-10-05

First public release: offline analysis, CLI, MCP server for coding agents, GitHub Action
and SARIF output.

### Added

- Offline analysis of SFDX source projects, driven by a git diff (`--base`/`--head`) or an
  explicit file list (`--files`).
- Parsers for custom fields (roll-up summaries, formulas), validation rules, record-triggered
  flows (`$Record`, typed variables, Get Records outputs, loops, subflows, Apex actions), Apex
  triggers and classes (heuristic DML/SOQL analysis) and permission sets/profiles.
- Simplified Salesforce order of execution per object and DML event.
- Cascade analysis across objects with cycle (re-entry) detection and a configurable depth.
- Findings: recursion cycles, validation-rule collisions with automated writes, fields used by
  validation rules, new validation rules vs existing automation, after-save self-updates,
  automation density, multiple triggers per object, DML/SOQL in loops, permission escalations
  (diffed against the git base), and deleted components that are still referenced.
- Suggested test plan per change (bulk, recursion, validation-collision, idempotency, boundary,
  permission-negative).
- Markdown (PR-comment ready) and JSON reports; `--fail-on` exit codes for CI.
- `preflight explain <Object>` to print an object's save procedure.
- Sample SFDX org fixture reproducing common failure modes.
- `preflight mcp`: read-only MCP server for coding agents with `analyze_change`,
  `explain_save_order` and `find_field_references` tools, scoped to a root directory.
- GitHub Action (`uses: visparashar/sf-preflight@v0`): PR comment that updates in place, job
  summary, optional SARIF upload to code scanning, `fail-on` threshold and outputs.
- SARIF 2.1.0 output (`--format sarif`) with rule metadata and repo-relative locations.
- `--md-out`, `--json-out` and `--sarif-out` to write several report formats in one run.
- AI-assisted commit detection from co-author trailers, tool markers and bot authors, shown in
  reports and exposed as an action output.
- Rule catalog and generated [rules reference](docs/RULES.md); findings carry line numbers
  where known, and cycle findings list the automations involved.

### Security

- Git refs from the CLI, MCP and the action are validated so they can't be parsed as git
  options.

[Unreleased]: https://github.com/visparashar/sf-preflight/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/visparashar/sf-preflight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/visparashar/sf-preflight/releases/tag/v0.1.0
