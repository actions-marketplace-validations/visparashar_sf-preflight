# Governance

This document describes how sf-preflight is run: who decides what, how decisions are made, and
how contributors can take on more responsibility. It is intentionally lightweight and will grow
with the project.

## Roles

**Users** run sf-preflight and help by reporting bugs, wrong findings and ideas.

**Contributors** are anyone who opens an issue, reviews a pull request, improves the docs or
contributes code. No permission is needed — see [CONTRIBUTING.md](CONTRIBUTING.md).

**Maintainers** are listed in [MAINTAINERS.md](MAINTAINERS.md). They:

- review and merge pull requests and triage issues,
- keep `main` releasable and cut releases (see the release steps in
  [CONTRIBUTING.md](CONTRIBUTING.md#releasing-maintainers)),
- handle security reports according to [SECURITY.md](SECURITY.md),
- enforce the [Code of Conduct](CODE_OF_CONDUCT.md),
- keep the [roadmap](docs/ROADMAP.md) current.

The **lead maintainer** (currently the project founder) has the final say when maintainers
cannot reach agreement and is responsible for the project's direction until the project adopts a
broader model.

## How decisions are made

Most decisions happen in the open, in issues and pull requests, by **lazy consensus**: a proposal
that has been visible for a reasonable time (normally at least three working days for anything
non-trivial) with no unresolved objection from a maintainer can go ahead.

- **Day-to-day changes** (bug fixes, docs, new tests, small features) need one approving review
  from a maintainer other than the author, when another maintainer is available.
- **Significant changes** — new rules or severities that change existing reports, new
  dependencies, changes to the JSON report or evidence-pack schema, CLI or action breaking
  changes, or changes to this document — start as an issue describing the problem and the
  proposed approach, and are labelled `breaking-change` where applicable.
- If consensus can't be reached, the lead maintainer decides and records the reasoning in the
  issue.

The project's [design principles](docs/ROADMAP.md#principles) — offline first, deterministic and
explainable findings, no LLM in the core analysis loop, tool-neutral — are the yardstick for
proposals. Changing them is a significant change.

## Becoming a maintainer

Contributors who have made sustained, high-quality contributions — code, reviews, triage or docs
— over several months and who show good judgment in line with the Code of Conduct can be
nominated by any maintainer. A nomination is accepted with the approval of the existing
maintainers (lazy consensus, with the lead maintainer's agreement). New maintainers are added to
[MAINTAINERS.md](MAINTAINERS.md) in a pull request.

Maintainers who are inactive for six months or who ask to step down move to the emeritus list.
They can return by asking. A maintainer can also be removed for a Code of Conduct violation.

## Releases and versioning

sf-preflight follows [Semantic Versioning](https://semver.org/). While the version is `0.x`, minor
releases may contain breaking changes; they are called out in [CHANGELOG.md](CHANGELOG.md) and in
the release notes. Releases are published to npm with provenance from the tagged commit by the
release workflow, never from a maintainer's machine.

## Licensing and contributions

All contributions are licensed under the [Apache License 2.0](LICENSE) and certified with the
[Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`). The
project does not require a contributor license agreement. Third-party code may only be added
with a compatible license and with its notice preserved in [NOTICE](NOTICE).

## Trademarks

Salesforce, Agentforce and related marks are trademarks of Salesforce, Inc. sf-preflight is
independent and is not affiliated with or endorsed by Salesforce.
