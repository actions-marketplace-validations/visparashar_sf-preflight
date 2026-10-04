# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `preflight mcp`: read-only MCP server for coding agents with `analyze_change`,
  `explain_save_order` and `find_field_references` tools, scoped to a root directory.
- GitHub Action (`uses: visparashar/sf-preflight@v0`): PR comment that updates in place, job
  summary, optional SARIF upload to code scanning, `fail-on` threshold and outputs.
- SARIF 2.1.0 output (`--format sarif`) with rule metadata and repo-relative locations.
- `--md-out`, `--json-out` and `--sarif-out` to write several report formats in one run.
- AI-assisted commit detection from co-author trailers, tool markers and bot authors, shown in
  reports and exposed as an action output.
- Rule catalog and generated [rules reference](docs/RULES.md); findings now carry line numbers
  where known, and cycle findings list the automations involved.

### Security

- Git refs from the CLI, MCP and the action are validated so they can't be parsed as git
  options.

### Changed

- The release workflow can be re-run safely and also moves the major version tag (`v0`) used
  by the GitHub Action.

## [0.1.0] - 2026-10-05

First public release.

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

[Unreleased]: https://github.com/visparashar/sf-preflight/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/visparashar/sf-preflight/releases/tag/v0.1.0
