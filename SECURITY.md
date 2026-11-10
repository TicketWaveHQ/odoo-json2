# Security policy

## Reporting a vulnerability

Please report security problems privately, by email to
**hello@ticketwavehq.com**, rather than in a public issue. TicketWave HQ's
disclosure policy is at <https://ticketwavehq.com/security>.

Useful details: the version of odoo-json2, which client (TypeScript or Python),
the runtime and its version, and steps to reproduce. Please do not include real
API keys, server addresses or customer data; a redacted example is enough.

## Supported versions

This project is at 0.1.0. Fixes are made on the latest release only.

## Scope

In scope: this library's own code, for example a way to make it send the API
key somewhere other than the configured server, to log it, or to follow a
redirect.

Out of scope: Odoo itself. Report vulnerabilities in Odoo to Odoo S.A. through
their own security process.

For guidance on issuing and holding API keys, see
[docs/security.md](docs/security.md).
