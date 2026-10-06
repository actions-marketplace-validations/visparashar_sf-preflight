# Getting help

sf-preflight is maintained by volunteers. This page explains where to ask what, so your question
reaches the right place and gets answered faster.

## Before you ask

- Read the [README](README.md) and the guide for what you're using:
  [GitHub Action](docs/GITHUB_ACTION.md), [MCP server](docs/MCP.md),
  [test generation](docs/TESTS.md), [Agentforce agents](docs/AGENTS.md),
  [policy and quality gate](docs/CONFIG.md), [evidence pack](docs/EVIDENCE.md),
  [other pipelines](docs/PIPELINES.md) and [org context](docs/ORG_CONTEXT.md).
- Check [docs/RULES.md](docs/RULES.md) for what each finding means, and
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what isn't modelled yet.
- Search [existing issues](https://github.com/visparashar/sf-preflight/issues?q=is%3Aissue), open
  and closed.
- Run with the latest version: `npx sf-preflight@latest --version`.

## Where to go

| You want to… | Go to |
|---|---|
| Report a crash, an error or wrong behavior | [Bug report](https://github.com/visparashar/sf-preflight/issues/new?template=bug_report.yml) |
| Report a finding that is wrong, missing or misleading | [Wrong or missing finding](https://github.com/visparashar/sf-preflight/issues/new?template=wrong_finding.yml) |
| Suggest a feature or a new rule | [Feature request](https://github.com/visparashar/sf-preflight/issues/new?template=feature_request.yml) (check the [roadmap](docs/ROADMAP.md) first) |
| Ask a usage question | Open an issue with the `question` label and include the command you ran |
| Report a security vulnerability | **Not in public.** Follow [SECURITY.md](SECURITY.md) |
| Report a Code of Conduct concern | Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#enforcement) |

## What to include

The fastest answers come from reports that include:

- the output of `preflight --version` and `node --version`,
- the exact command (or the action's `with:` block) you ran,
- the full error or the part of the report that looks wrong,
- a **minimal, anonymised** SFDX snippet that reproduces it — ideally a few metadata files that
  could be added to [`fixtures/sample-org`](fixtures/sample-org).

Never post org credentials, auth URLs, customer data or confidential metadata. Rename objects,
fields and classes where needed; the shape of the metadata is what matters.

## What to expect

This is a community project without a support agreement. Maintainers aim to triage new issues
within a week, but can't promise a fix or a timeline. Pull requests with a failing test or a
fixture snippet usually move fastest — see [CONTRIBUTING.md](CONTRIBUTING.md).

sf-preflight is independent of Salesforce. For problems with Salesforce itself, the Salesforce
CLI, DevOps Center or Agentforce, use Salesforce's own support channels.
