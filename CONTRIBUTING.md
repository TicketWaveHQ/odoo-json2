# Contributing

Thank you for helping. This project aims to stay small: a thin, correct layer
over Odoo's JSON-2 API in two languages, with no runtime dependencies.

## Before you start

- For anything beyond a small fix, open an issue first so we can agree the
  shape of the change.
- Keep the two clients in step. A behaviour added to one should be added to
  the other, with tests in both, unless the language makes it impossible (say
  so in the pull request).
- Runtime dependencies are not accepted. The TypeScript side has one
  development dependency, `typescript`.

## Running the tests

Nothing in the test suites touches a network beyond `127.0.0.1`.

```sh
# TypeScript (Node 20 or later)
cd js
npm ci
npm test

# Python (3.10 or later)
cd python
python3 -m unittest discover -s tests -v
```

## What a good change includes

- A test against the mock server (`js/test/mock-odoo.mjs`,
  `python/tests/mock_odoo.py`) for every behaviour change.
- If the change depends on how Odoo behaves, a link to the Odoo documentation
  or source that shows it, with the Odoo version. If you could not confirm a
  detail, say so in the pull request and in the README rather than guess.
- A line in `CHANGELOG.md` under an "Unreleased" heading.

## Never in a pull request, issue or test

- A real API key, password, server address, database name or customer record.
  Use `https://odoo.example.com`, the database name `example`, and the
  placeholder key in the mock servers.
- Odoo error payloads copied from a real server without redaction: their
  `message` and `debug` members can quote personal data.

## Style

- TypeScript: strict mode, ES modules, erasable syntax only (no enums or
  namespaces). `js/src/index.ts` loads directly under Node 24's built-in type
  stripping; keep it that way.
- Python: standard library only, type hints, compatible with 3.10.
- Documentation in UK English.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence in [LICENSE](LICENSE).
