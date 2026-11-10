# Migrating from XML-RPC or `/jsonrpc` to JSON-2

Odoo's External JSON-2 API is new in Odoo 19.0. Odoo's documentation for 19.0
says the XML-RPC and JSON-RPC endpoints (`/xmlrpc`, `/xmlrpc/2` and `/jsonrpc`)
are scheduled for removal in Odoo 22 (fall 2028) and Odoo Online 21.1 (winter
2027). The 20.0 documentation adds that the `db` service was removed in Odoo 20
(fall 2026) and Odoo Online 19.1, and that the `common` and `object` services
are still scheduled for removal in Odoo 22 and Online 21.1. In the 19.0 source,
every call to those endpoints logs a deprecation warning on the server.

Only the external RPC endpoints are deprecated. Controllers declared with
`@route(type='jsonrpc')` (called `type='json'` until Odoo 18) are not, per the
same documentation.

## What changes

| | XML-RPC / `/jsonrpc` | JSON-2 |
|---|---|---|
| Endpoint | `/xmlrpc/2/common`, `/xmlrpc/2/object`, or `POST /jsonrpc` with a service name | `POST /json/2/<model>/<method>` |
| Authentication | `login` or `authenticate` returns a user id; every call then carries the database, the user id and the password (or an API key in its place) | `Authorization: bearer <API key>` on every call. No login step, no user id, no password |
| Which user | The login | The user who owns the key |
| Database | First argument of every call | `X-Odoo-Database` header, and only where one server hosts several databases and its `dbfilter` does not pick one from the host name |
| Arguments | Positional (`args`) plus keyword (`kw`); record ids are the first positional argument | A JSON object of named arguments only. Record ids go in `ids`, the context in `context`. There are no positional arguments |
| Return value | The method's return value | The same, as JSON. A recordset comes back as its list of ids |
| Errors | XML-RPC: an `xmlrpc.client.Fault`. `/jsonrpc`: HTTP 200 with an `error` member | An HTTP 4xx or 5xx whose JSON body is `{name, message, arguments, context, debug}` |
| Server version | `common.version()` | `GET /web/version` (no key needed) |
| Own user id | Returned by `login` | `res.users/context_get` with no ids returns it as `uid` |

## Side by side: Python

**Before, XML-RPC:**

```python
import xmlrpc.client

url, db = "https://odoo.example.com", "example"
login, password = "integration@example.com", "..."  # or an API key in place of the password

common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid = common.authenticate(db, login, password, {})
models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object", allow_none=True)

partners = models.execute_kw(
    db, uid, password, "res.partner", "search_read",
    [[["is_company", "=", True]]],
    {"fields": ["name"], "limit": 5},
)
models.execute_kw(db, uid, password, "res.partner", "write", [[1, 2], {"comment": "Checked"}])
```

**After, JSON-2 with this library:**

```python
from odoo_json2 import OdooClient

odoo = OdooClient("https://odoo.example.com", api_key, database="example")  # database only if needed

partners = odoo.search_read("res.partner", [["is_company", "=", True]], ["name"], limit=5)
odoo.write("res.partner", [1, 2], {"comment": "Checked"})
```

**After, JSON-2 with the standard library only**, to show the wire format:

```python
import json
import urllib.request

req = urllib.request.Request(
    "https://odoo.example.com/json/2/res.partner/search_read",
    method="POST",
    headers={
        "Authorization": f"bearer {api_key}",
        "X-Odoo-Database": "example",  # only if needed
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "example-sync",
    },
    data=json.dumps({
        "domain": [["is_company", "=", True]],
        "fields": ["name"],
        "limit": 5,
    }).encode("utf-8"),
)
with urllib.request.urlopen(req, timeout=30) as resp:
    partners = json.load(resp)
```

Note that plain `urlopen` follows redirects and copies the `Authorization`
header to wherever the redirect points. This library refuses redirects for that
reason; see [security.md](security.md).

## Side by side: JavaScript or TypeScript

**Before, `/jsonrpc`:**

```js
async function rpc(service, method, args) {
  const res = await fetch("https://odoo.example.com/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: 1 }),
  });
  const body = await res.json();
  // Failures arrive as HTTP 200 with an `error` member.
  if (body.error) throw new Error(body.error.data?.name ?? body.error.message);
  return body.result;
}

const uid = await rpc("common", "login", [db, login, password]);
const partners = await rpc("object", "execute_kw", [
  db, uid, password, "res.partner", "search_read",
  [[["is_company", "=", true]]],
  { fields: ["name"], limit: 5 },
]);
```

**After, JSON-2 with this library:**

```ts
import { OdooClient } from "odoo-json2";

const odoo = new OdooClient({ url: "https://odoo.example.com", apiKey, database: "example" });
const partners = await odoo.searchRead("res.partner", {
  domain: [["is_company", "=", true]],
  fields: ["name"],
  limit: 5,
});
```

**After, JSON-2 with plain `fetch`:**

```js
const res = await fetch("https://odoo.example.com/json/2/res.partner/search_read", {
  method: "POST",
  headers: {
    Authorization: `bearer ${apiKey}`,
    "X-Odoo-Database": "example", // only if needed
    "Content-Type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({ domain: [["is_company", "=", true]], fields: ["name"], limit: 5 }),
  redirect: "manual", // never re-send the key to a redirect target
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`); // the body is { name, message, ... }
const partners = await res.json();
```

## Translating positional arguments into names

JSON-2 binds the body to the Python method's signature, so every argument needs
its parameter name. The names below are from `odoo/orm/models.py` in Odoo 19.0
and 20.0. For any other method, read its signature in the source, or see the
database's own `/doc` page, which Odoo's documentation describes as listing the
models, fields and methods available on that database.

| XML-RPC `execute_kw` call | JSON-2 body |
|---|---|
| `search`, `[domain]`, `{offset, limit, order}` | `{"domain": [...], "offset": 0, "limit": 80, "order": "name"}` |
| `search_count`, `[domain]` | `{"domain": [...]}` (also takes `limit`) |
| `search_read`, `[domain]`, `{fields, offset, limit, order}` | `{"domain": [...], "fields": [...], ...}` |
| `read`, `[ids, fields]` | `{"ids": [...], "fields": [...]}` (also takes `load`) |
| `create`, `[vals]` or `[[vals, ...]]` | `{"vals_list": [{...}, ...]}`, which returns a list of ids |
| `write`, `[ids, vals]` | `{"ids": [...], "vals": {...}}` |
| `unlink`, `[ids]` | `{"ids": [...]}` |
| `fields_get`, `[]`, `{allfields, attributes}` | `{"allfields": [...], "attributes": [...]}` |
| `name_search`, `[name]`, `{domain, operator, limit}` | `{"name": "...", "domain": [...], "operator": "ilike", "limit": 100}` |
| `copy`, `[[id]]`, `{default}` | `{"ids": [id], "default": {...}}` |
| any record method, `[ids, a, b]` | `{"ids": [...], "<name of a>": a, "<name of b>": b}` |

Two errors from the JSON-2 controller in 19.0 are worth knowing when
translating: arguments that do not match the method's signature are refused
with HTTP 422 and the binding error as the message, and sending `ids` to a
method decorated with `@api.model` is also a 422 ("cannot call ... with ids").

## Errors

JSON-2 reports failures with an HTTP status and a JSON body:

```json
{
  "name": "werkzeug.exceptions.Unauthorized",
  "message": "Invalid apikey",
  "arguments": ["Invalid apikey", 401],
  "context": {},
  "debug": "Traceback (most recent call last): ..."
}
```

The documentation gives the shape and the 401 example above. It does not list
which status goes with which exception. In the 19.0 and 20.0 source, the
statuses are:

| Status | Raised for |
|---|---|
| 400 | A body that is not valid JSON (`werkzeug.exceptions.BadRequest`) |
| 401 | A missing, wrong, expired or revoked key (`werkzeug.exceptions.Unauthorized`) |
| 403 | `odoo.exceptions.AccessError` and `AccessDenied` |
| 404 | An unknown model or method (`werkzeug.exceptions.NotFound`), or a record that no longer exists (`odoo.exceptions.MissingError`) |
| 409 | `odoo.exceptions.LockError` |
| 422 | `odoo.exceptions.UserError` and its subclass `ValidationError`, and arguments that do not fit the method (`werkzeug.exceptions.UnprocessableEntity`) |
| 500 | Anything else |

A wrong or missing database name behaves differently. In our reading of the 19.0
source, when no database is selected the JSON-2 route is not found at all and
the server answers 404 with an HTML page rather than the JSON error object. This
library raises an `OdooHttpError` with `status` 404, no `payload`, and the start
of the page in `body`. The preflight script names this case.

For comparison, `/jsonrpc` answers HTTP 200 with
`{"jsonrpc": "2.0", "id": ..., "error": {"code": ..., "message": "Odoo Server Error", "data": {name, message, arguments, context, debug}}}`,
and `/xmlrpc/2` raises an `xmlrpc.client.Fault` whose `faultCode` is 1
(application error, with the traceback as `faultString`), 2 (a `UserError` or
warning), 3 (`AccessDenied`) or 4 (`AccessError`).

## Behaviour to carry over

- `create` takes `vals_list` and returns a list of ids, even for one record.
- Relational commands such as `[[6, 0, ids]]` for a many2many are the ORM's own
  and do not change.
- A search skips archived records unless the context says
  `{"active_test": false}`.
- `unlink` on several ids is all or nothing, because the call is one
  transaction: if one record cannot be deleted, none is.
- Related writes that must succeed or fail together need one server-side method
  (a business method such as `action_confirm`, or one in your own module). The
  documentation is explicit that calls cannot be chained in one transaction.

## Checklist

1. Run Odoo 19.0 or later. JSON-2 does not exist on earlier versions.
2. Create a dedicated user for the integration with only the access rights it
   needs, and an API key for it (Preferences, Account Security, New API Key).
   Odoo requires a description and a duration, and the documentation says a
   key cannot be created to last more than three months. Plan the rotation.
3. Remove the login step. If you need the user id, call `res.users/context_get`.
4. Rename every positional argument (table above).
5. Send `X-Odoo-Database` only if the server needs it.
6. Replace "HTTP 200 with an error member" handling with HTTP status handling.
7. Run the preflight script against the new configuration before you switch.
