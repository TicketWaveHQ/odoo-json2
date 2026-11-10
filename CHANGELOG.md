# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-10

First release.

### Added

- TypeScript client (`js/`): `OdooClient` with `call`, `searchRead`, `search`,
  `searchCount`, `read`, `create`, `write`, `unlink`, `fieldsGet`,
  `contextGet` and `version`; per-attempt timeouts and `AbortSignal`
  cancellation; typed errors (`OdooHttpError`, `OdooTimeoutError`,
  `OdooAbortError`, `OdooNetworkError`, `OdooResponseError`,
  `OdooConfigError`) carrying Odoo's error payload; opt-in retries for
  read-only methods; `clientFromEnv`.
- Python client (`python/`): the same calls in snake case, on `urllib` only.
- Both clients refuse plain http except to loopback, never follow redirects,
  and keep Odoo's message text out of error messages.
- Preflight scripts for both: `odoo-json2-preflight` (Node) and
  `python -m odoo_json2.preflight`.
- Offline test suites against a local mock server, and CI for Node 20, 22 and
  24 and Python 3.10 to 3.14.
- Migration guide from XML-RPC and `/jsonrpc`, and a security note on API keys.

[0.1.0]: https://github.com/TicketWaveHQ/odoo-json2/releases/tag/v0.1.0
