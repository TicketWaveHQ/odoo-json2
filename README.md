# odoo-json2

Small, dependency-free clients for **Odoo's External JSON-2 API**, in
TypeScript and in Python, with a preflight script that proves a URL, database
and API key work before you rely on them.

JSON-2 is the API Odoo added in **Odoo 19.0**: `POST /json/2/<model>/<method>`,
an API key as a bearer token, named arguments in a JSON body, and real HTTP
status codes for errors. Odoo's documentation says the older XML-RPC and
`/jsonrpc` endpoints are scheduled for removal in Odoo 22. This library is a
thin, careful layer over JSON-2 and nothing more: no models, no ORM, no
dependencies.

**Who it is for:** developers connecting a website, a sync job or a script to
an Odoo 19 or later database, and anyone moving an existing XML-RPC or
`/jsonrpc` integration to JSON-2 (see the [migration guide](docs/migration.md)).

- TypeScript: the client is one ESM file on `fetch`, with timeouts, `AbortSignal`
  cancellation and typed errors. Node 20 or later; written for edge runtimes
  too (see [Tested on](#tested-on)).
- Python 3.10 or later: one module on `urllib`.
- Both: https only, redirects never followed (the key would go with them),
  no retries of writes unless you ask, and error messages that are safe to log.

Status: 0.1.0. Not yet published to npm or PyPI; install from a checkout as
shown below.

## 60-second start

### TypeScript or JavaScript

```sh
git clone https://github.com/TicketWaveHQ/odoo-json2.git
cd odoo-json2/js && npm ci && npm run build
cd /path/to/your/app && npm install /path/to/odoo-json2/js
```

`js/src/index.ts` has no imports, so you can also copy that one file into your
project.

```ts
import { OdooClient } from "odoo-json2";

const odoo = new OdooClient({
  url: "https://odoo.example.com",
  apiKey: process.env.ODOO_API_KEY!,
  database: "example", // only if the server hosts several databases
});

const me = await odoo.contextGet(); // { uid, lang, tz }
const companies = await odoo.searchRead("res.partner", {
  domain: [["is_company", "=", true]],
  fields: ["name", "email"],
  limit: 10,
});
const [id] = await odoo.create("res.partner", { name: "Example Ltd", is_company: true });
await odoo.write("res.partner", [id], { email: "hello@example.com" });
```

### Python

```sh
git clone https://github.com/TicketWaveHQ/odoo-json2.git
pip install ./odoo-json2/python
```

`python/src/odoo_json2/client.py` uses the standard library only, so you can
also copy that one file.

```python
import os
from odoo_json2 import OdooClient

odoo = OdooClient(
    "https://odoo.example.com",
    os.environ["ODOO_API_KEY"],
    database="example",  # only if the server hosts several databases
)

me = odoo.context_get()  # {"uid": ..., "lang": ..., "tz": ...}
companies = odoo.search_read("res.partner", [["is_company", "=", True]], ["name", "email"], limit=10)
[new_id] = odoo.create("res.partner", {"name": "Example Ltd", "is_company": True})
odoo.write("res.partner", [new_id], {"email": "hello@example.com"})
```

### Check the connection first

```sh
export ODOO_URL=https://odoo.example.com
export ODOO_DATABASE=example                 # only if needed
read -rs ODOO_API_KEY && export ODOO_API_KEY  # typed, not echoed, not in history

node js/dist/preflight.js --model res.partner
# or
PYTHONPATH=python/src python3 -m odoo_json2.preflight --model res.partner
```

The preflight makes read-only calls only: `GET /web/version`,
`res.users/context_get`, `res.users/has_group` (is the key's user a Settings
administrator?) and, for each `--model`, `has_access` for read, write, create
and unlink. It never prints the key, and there is no command-line flag for it.
Exit code 0 means every check passed, 1 that one failed, 2 a usage error. This
is its output against the test suite's mock server:

```text
odoo-json2 preflight 0.1.0

Configuration
  PASS  URL and key present
  INFO  database: example (sent as X-Odoo-Database)
  WARN  URL is plain http to a loopback address
        Fine for a local test server, never for a real one.

Server
  PASS  reached /web/version  server 19.0

The key
  PASS  the key is accepted (res.users/context_get)  user id 7, lang en_GB, tz Europe/London
  PASS  the key's user is not a Settings administrator

Access rights (has_access, model level)
  INFO  res.partner: read yes, write yes, create yes, unlink no

All checks passed. Read any warnings above.
```

## What a call looks like on the wire

```http
POST /json/2/res.partner/search_read HTTP/1.1
Host: odoo.example.com
Authorization: bearer <API key>
X-Odoo-Database: example
Content-Type: application/json; charset=utf-8
Accept: application/json
User-Agent: odoo-json2/0.1.0

{"domain": [["is_company", "=", true]], "fields": ["name"], "limit": 10}
```

A success is HTTP 200 with the method's return value as JSON (a recordset comes
back as its list of ids). A failure is a 4xx or 5xx with
`{"name", "message", "arguments", "context", "debug"}`. Record ids go in `ids`,
the context in `context`, and every other argument by its Python parameter
name.

## API reference: TypeScript

### `new OdooClient(options)`

| Option | Default | |
|---|---|---|
| `url` | required | Base URL. https only, except to `localhost`, `127.0.0.0/8` or `::1`. A path prefix is kept; a trailing slash is dropped. |
| `apiKey` | required | The user's API key. Never a password. |
| `database` | none | Sent as `X-Odoo-Database`. |
| `timeoutMs` | `30000` | Per attempt, including reading the body. |
| `context` | `{}` | Merged into every call's context; the call's own context wins. |
| `retries` | `0` | Extra attempts on a network error, timeout, or HTTP 429, 502, 503, 504. Read-only methods only, unless a call says `idempotent: true`. |
| `retryDelayMs` | `500` | Doubled after each attempt. |
| `userAgent` | `odoo-json2/0.1.0` | Odoo's documentation recommends naming your software. |
| `fetch` | global `fetch` | For tests, proxies or instrumentation. |
| `allowInsecureHttp` | `false` | Permit plain http to any host. |
| `dangerouslyAllowBrowser` | `false` | Permit construction in a page with `window` and `document`. See [security](docs/security.md). |

Invalid options throw `OdooConfigError`.

### Methods

Every method returns a promise and takes an optional last argument
`{ signal?: AbortSignal, timeoutMs?: number, idempotent?: boolean }`.

| Method | JSON-2 call | Resolves to |
|---|---|---|
| `call(model, method, params?)` | `model/method`, `params` as the body (`ids`, `context`, named arguments) | the method's return value |
| `searchRead(model, { domain?, fields?, offset?, limit?, order?, context? })` | `search_read` | records |
| `search(model, { domain?, offset?, limit?, order?, context? })` | `search` | ids |
| `searchCount(model, { domain?, limit?, context? })` | `search_count` | a number |
| `read(model, ids, { fields?, load?, context? })` | `read` | records |
| `create(model, values or [values], { context? })` | `create` with `vals_list` | new ids, always a list |
| `write(model, ids, values, { context? })` | `write` with `ids`, `vals` | `true` |
| `unlink(model, ids, { context? })` | `unlink` with `ids` | `true` |
| `fieldsGet(model, { allfields?, attributes?, context? })` | `fields_get` | field definitions by name |
| `contextGet()` | `res.users/context_get` | `{ uid, lang, tz }` of the key's user |
| `version()` | `GET /web/version`, without the key | `{ version, version_info }` |

`domain` defaults to `[]`. Model and method names are checked against
`[A-Za-z0-9_.]` and `[A-Za-z_][A-Za-z0-9_]*` before anything is sent, and ids
must be positive integers; a bad argument rejects with `TypeError`.

Also exported: `clientFromEnv(env, options?)`, which reads `ODOO_URL`,
`ODOO_API_KEY` and optional `ODOO_DATABASE` and returns `null` when either of
the first two is missing; `READ_ONLY_METHODS`; `VERSION`; and the types
`Context`, `Domain`, `Values`, `OdooRecord`, `CallParams`, `CallOptions`,
`OdooErrorPayload`.

### Errors

All extend `OdooError`, which carries `model` and `method` where the error
belongs to a call.

| Class | When | Useful properties |
|---|---|---|
| `OdooHttpError` | a non-2xx status, or a redirect (never followed) | `status`, `exception` (e.g. `odoo.exceptions.AccessError`), `exceptionName` (`AccessError`), `location` for a redirect, `payload` (Odoo's error object), `body` (start of a non-JSON body) |
| `OdooTimeoutError` | the attempt passed `timeoutMs`, body included | `cause` |
| `OdooAbortError` | your `signal` aborted | `cause` is the signal's reason |
| `OdooNetworkError` | `fetch` failed: DNS, TLS, refused, reset | `cause` |
| `OdooResponseError` | a 2xx that is not JSON, or a helper got the wrong shape | `status`, `body` |
| `OdooConfigError` | invalid constructor options | |

`error.message` never contains Odoo's own message text, which can quote the
values you sent; it reads like `Odoo res.partner/create: HTTP 422
odoo.exceptions.ValidationError`. Odoo's text is on `error.payload.message`,
and its traceback on `error.payload.debug`. `payload` and `body` are
non-enumerable, so a logger that serialises the error does not write them.

```ts
import { OdooHttpError } from "odoo-json2";

try {
  await odoo.create("res.partner", { email: "hello@example.com" });
} catch (err) {
  if (err instanceof OdooHttpError && err.status === 401) {
    // the key is wrong, expired or revoked
  } else if (err instanceof OdooHttpError && err.exceptionName === "ValidationError") {
    console.warn(err.message); // safe to log
    showToOperator(err.payload?.message); // Odoo's text, which may quote the input
  } else {
    throw err;
  }
}
```

## API reference: Python

### `OdooClient(url, api_key, *, ...)`

| Parameter | Default | |
|---|---|---|
| `url` | required | As for TypeScript. |
| `api_key` | required | |
| `database` | `None` | Sent as `X-Odoo-Database`. |
| `timeout` | `30.0` | Seconds. See [Limits](#limits) for what it bounds. |
| `context` | `None` | Merged into every call's context. |
| `retries` | `0` | As for TypeScript. |
| `retry_delay` | `0.5` | Seconds, doubled after each attempt. |
| `user_agent` | `odoo-json2/0.1.0 (Python)` | |
| `allow_insecure_http` | `False` | |
| `ssl_context` | `None` | An `ssl.SSLContext`, for a private certificate authority. |
| `opener` | built in | A `urllib.request.OpenerDirector`. It must not follow redirects. |

Invalid options raise `OdooConfigError`, a subclass of both `OdooError` and
`ValueError`.

### Methods

Every method also takes keyword-only `timeout=`; `call`, `create`, `write` and
`unlink` take `idempotent=`.

| Method | JSON-2 call | Returns |
|---|---|---|
| `call(model, method, params=None, *, ids=None, context=None)` | `model/method` | the method's return value |
| `search_read(model, domain=None, fields=None, *, offset, limit, order, context, **extra)` | `search_read` | list of dicts |
| `search(model, domain=None, *, offset, limit, order, context)` | `search` | list of ids |
| `search_count(model, domain=None, *, limit, context)` | `search_count` | int |
| `read(model, ids, fields=None, *, context, **extra)` | `read` | list of dicts |
| `create(model, values or [values], *, context)` | `create` with `vals_list` | list of new ids |
| `write(model, ids, values, *, context)` | `write` | `True` |
| `unlink(model, ids, *, context)` | `unlink` | `True` |
| `fields_get(model, allfields=None, attributes=None, *, context)` | `fields_get` | dict |
| `context_get()` | `res.users/context_get` | `{"uid", "lang", "tz"}` |
| `version()` | `GET /web/version`, without the key | dict |

`params` in `call()` is a mapping of the method's named arguments, so an
argument whose name clashes with a Python keyword or with `call()`'s own
parameters still works: `odoo.call("res.partner", "name_search", {"name": "Ex", "limit": 5})`.

Also: `client_from_env(env=None, **options)` (reads `os.environ` by default),
`READ_ONLY_METHODS`, `__version__`.

### Errors

`OdooError` and its subclasses `OdooHTTPError` (`status`, `exception`,
`exception_name`, `location`, `payload`, `body`), `OdooTimeoutError`,
`OdooNetworkError` (the cause is on `__cause__`), `OdooResponseError` and
`OdooConfigError`. As in TypeScript, `str(error)` carries no Odoo message text;
read `error.payload["message"]` for that. Invalid arguments raise `TypeError`.

```python
from odoo_json2 import OdooHTTPError

try:
    odoo.create("res.partner", {"email": "hello@example.com"})
except OdooHTTPError as err:
    if err.status == 401:
        ...  # the key is wrong, expired or revoked
    elif err.exception_name == "ValidationError":
        log.warning("%s", err)          # safe to log
        detail = err.payload["message"]  # Odoo's text, which may quote the input
    else:
        raise
```

## Timeouts, cancellation and retries

- Each attempt has its own deadline (`timeoutMs` / `timeout`). To give several
  calls one shared budget in TypeScript, pass the same signal to each:
  `const signal = AbortSignal.timeout(5000)`, then `{ signal }` on every call.
- There are **no retries by default**. With `retries` set, only methods in
  `READ_ONLY_METHODS` are retried, and only after a network error, a timeout,
  or HTTP 429, 502, 503 or 504. A 4xx is never retried. A `create`, `write`,
  `unlink` or any other method is retried only if you pass `idempotent: true`
  (`idempotent=True`), because a call that timed out may still have committed.
- Delays double from `retryDelayMs` / `retry_delay`. `Retry-After` is not read.

## A pattern for best-effort integrations

When Odoo is a secondary destination (a website form that also files a lead,
say), the integration should stay off until configured and should never cost
the visitor more than a fixed budget:

```ts
import { clientFromEnv } from "odoo-json2";

const odoo = clientFromEnv(process.env, { timeoutMs: 5000 });

export async function fileLead(values: Record<string, unknown>) {
  if (!odoo) return { ok: false, skipped: true }; // not configured: send nothing
  try {
    const [id] = await odoo.create("crm.lead", values);
    return { ok: true, id };
  } catch (err) {
    console.warn(String(err)); // no field values in the message
    return { ok: false, skipped: false };
  }
}
```

## Tested on

- **TypeScript client:** the test suite (38 tests) passes on Node 20.20.2 and
  Node 24.14.0. CI is configured for Node 20, 22 and 24. The client uses only
  `fetch`, `Response`, `AbortController`, `URL` and timers, so it is written to
  run on edge runtimes such as Cloudflare Workers, Deno and Bun, but it has not
  been tested on any of them.
- **Python client:** the test suite (33 tests) passes on Python 3.10.22 and
  3.14.6. CI is configured for 3.10 to 3.14.
- **Odoo:** the tests run against a local mock server that reproduces the
  request and response shapes in Odoo's documentation and source. This
  repository's tests have not been run against a live Odoo server. Please run
  the preflight against yours and report anything that differs.

## Limits

- **Odoo 19.0 or later.** JSON-2 does not exist on earlier versions. Odoo's
  documentation also says that on Odoo Online, external API access is only
  available on Custom pricing plans.
- **One transaction per call.** JSON-2 cannot group calls. Related changes
  that must succeed or fail together need one server-side method.
- **No redirects.** Point the client at the final URL.
- **Python timeouts** bound each socket operation (connect, each read), and
  the body is also checked against the deadline between reads of up to 64 KiB.
  The status line and headers are not, so a server that trickles bytes can
  still take longer than `timeout` overall.
- **Python is synchronous** and has no cancellation. Use threads or an
  executor for concurrency.
- **Retries are chosen by method name.** A custom module can override a
  read-only name such as `search` to write; for such a model pass
  `idempotent=False` or keep `retries` at 0.
- **Whole responses are read into memory.** There is no streaming.
- **Not wrapped:** API key generation and revocation
  (`res.users.apikeys/generate` and `/revoke`), the database manager
  controllers, and the per-database `/doc` page. `call()` reaches any public
  model method.
- **The browser guard is a heuristic** (it looks for `window` and `document`).
  It is not a security boundary.

## What was checked, and against what

Checked against Odoo's documentation, "External JSON-2 API", for 19.0 and 20.0:
the endpoint; the headers (`Authorization: bearer` and `Content-Type` required,
`X-Odoo-Database` optional and needed where one server hosts several databases
and `dbfilter` does not use the host, `User-Agent` recommended); the body
(`ids`, `context`, named arguments only); the success and error responses and
the error object's fields; the 401 example; one transaction per call; API key
creation, durations and the three-month limit; dedicated bot users;
`res.users/context_get` for the user id; `GET /web/version`; programmatic key
management; and the deprecation timeline for XML-RPC and `/jsonrpc`.

Checked against Odoo's source code on GitHub (branches 19.0 and 20.0), because
the documentation does not say: which HTTP status each exception gets; 404 for
an unknown model or method and 422 for arguments that do not fit the method;
recordsets returned as ids; the keys `context_get` returns; the ORM methods'
argument names; the API key format; and what happens when no database is
selected.

Not checked: behaviour on Odoo Online beyond what the documentation says;
differences between Community and Enterprise (none were found in the files
read, but none were tested); how reverse proxies in front of Odoo change error
bodies; keys created with a scope other than the default; and the edge
runtimes named above.

## Repository layout

```text
js/        TypeScript client, preflight CLI and tests (node:test)
python/    Python client, preflight module and tests (unittest)
docs/      migration guide and security note
```

## Contributing, security and licence

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md). Guidance on issuing and holding keys
is in [docs/security.md](docs/security.md). MIT licence; see [LICENSE](LICENSE).

Odoo is a trademark of Odoo S.A. This project is independent and is not
affiliated with or endorsed by Odoo S.A.

Maintained by [TicketWave HQ](https://ticketwavehq.com), a UK company (Companies House 17143167).
