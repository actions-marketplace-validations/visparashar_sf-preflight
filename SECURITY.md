# Security Policy

## Supported versions

sf-blast-radius is pre-1.0. Security fixes are made on the latest released minor version.

| Version | Supported |
|---|---|
| 0.x (latest) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/visparashar/sf-blast-radius/security/advisories/new)
("Report a vulnerability" on the repository's **Security** tab).

Please include:

- a description of the issue and its impact,
- steps or a minimal SFDX project / input that reproduces it,
- the version (`blast-radius --version`) and Node.js version you used.

You can expect an acknowledgement within **5 business days**. We will keep you informed while we
investigate, agree a disclosure date with you, and credit you in the advisory unless you prefer
otherwise.

## Scope

sf-blast-radius reads Salesforce metadata from a local SFDX project and runs `git` locally. It
does not contact Salesforce orgs or external services in the current release. Issues of
particular interest include:

- code execution or command injection via crafted metadata files, paths or git refs,
- path traversal outside the project directory,
- denial of service from crafted metadata (e.g. pathological XML or Apex input),
- leaking sensitive metadata into reports in unexpected ways.
