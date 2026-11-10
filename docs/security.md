# Security note: API keys for JSON-2

A JSON-2 API key is a bearer credential: whoever holds it acts as its user, with
that user's access rights, until the key expires or is revoked. There is no
second factor and no login step to slow anyone down. Treat it like a password
that works from anywhere the server is reachable.

This note covers how to issue, hold and retire keys for integrations. For
reporting a vulnerability in this library, see [SECURITY.md](../SECURITY.md).

## One key per integration, on a least-privilege user

Odoo's documentation recommends dedicated bot users for automated use, and
dedicated keys per service. In practice:

- **Give each integration its own user.** A website form that files leads, a
  nightly sync and a reporting script are three users, not one. When one key
  leaks, you revoke one key and you know exactly what it could reach.
- **Grant only what the integration needs.** JSON-2 enforces the user's access
  rights, record rules and field access on every call, so the user's groups are
  the integration's ceiling. A form that only creates leads does not need to
  delete them, see other people's leads, or administer Settings. The preflight
  script warns when a key's user is a Settings administrator, and
  `--model <name>` shows which of read, write, create and unlink it may do.
- **Disable password login for the bot.** The documentation notes the
  password can be left empty, so the account can only be used through its keys.
- **Never use a person's key for a service.** The person leaves, the key
  breaks, and the audit trail blames them for the integration's writes.

## Keys expire

Odoo's documentation for 19.0 and 20.0 says that a key needs a description and
a duration when it is created, that a short duration (typically one day) is
recommended for interactive use, and that keys cannot be created to last more
than three months. Long-lived integrations therefore need a rotation plan:

1. Generate the new key before the old one expires.
2. Store it in your secret store and deploy it.
3. Confirm every instance uses the new key (the preflight helps).
4. Revoke the old key.

Odoo also offers programmatic rotation through `res.users.apikeys/generate`
and `res.users.apikeys/revoke`. By default only users with the Settings
administration right may use them, unless the system parameter
`base.enable_programmatic_api_keys` is set. The documentation describes the
arguments (`key`, `scope`, `name`, `expiration_date`) and says the expiration
date is validated against the maximum duration the user's roles allow. This
library does not wrap those methods; call them with `call()` if you need them,
and keep the generated key out of logs.

From Odoo 20, keys that Odoo generates end in `_oak`. In 19.0 they are 40
hexadecimal characters. The preflight warns when a key looks like neither,
because the usual mistake is pasting the user's password.

## Never ship a key to a browser

Anything in a web page, a mobile app bundle or a desktop app can be read by
whoever runs it. A key there is a key published. Call Odoo from your server,
expose only the narrow operation the page needs (for example "submit this
form"), and validate the input there.

The TypeScript client refuses to construct when it sees both `window` and
`document`, unless you pass `dangerouslyAllowBrowser: true`. That check is a
guard rail against mistakes, not a security boundary: the only real defence is
not putting the key in the bundle.

## Keep the key where it belongs

- **Environment or secret store, never source control.** `clientFromEnv` and
  `client_from_env` read `ODOO_URL`, `ODOO_API_KEY` and `ODOO_DATABASE`.
- **Not on the command line.** Arguments land in shell history and process
  listings. The preflight takes the key from the environment only and has no
  flag for it. In an interactive shell, `read -rs ODOO_API_KEY && export
  ODOO_API_KEY` keeps it off the screen and out of history.
- **https only.** The key travels in the `Authorization` header. Both clients
  refuse plain http except to a loopback address (`localhost`, `127.0.0.0/8`,
  `::1`) unless you set `allowInsecureHttp` / `allow_insecure_http`.
- **No redirects.** A redirect can carry the header to the new address. Python's
  `urllib`, for example, follows a 301, 302 or 303 after a POST as a GET to
  whatever host it names, and copies every header except the content headers,
  `Authorization` included. Whether a fetch implementation strips the header
  depends on the runtime. Both clients refuse to follow redirects and raise an
  error naming the `Location`. Point the client at the final URL instead.
- **Not in the client's printed form.** The TypeScript client keeps the key in
  a non-enumerable property and leaves it out of `toJSON()`. The Python
  client's `repr()` omits it.

## Logs: Odoo's error text can quote your data

Odoo's error payload has a `message`, which can quote the values you sent (an
email address in a validation error, say), and a `debug` member, which is a
server traceback. Neither belongs in logs that personal data must not reach.

Both clients keep `error.message` / `str(error)` to a safe summary: the model,
the method, the HTTP status and the exception class. Odoo's own text is on
`error.payload`, which the TypeScript client makes non-enumerable so that a
structured logger serialising the error does not write it by accident. Log the
summary; read the payload only where you need it, such as an interactive
script.

## Untrusted input

Values you send are data to Odoo, but fields of type `html` render as HTML in
the Odoo interface (`crm.lead`'s `description`, for example, in 19.0). If you
copy text a member of the public typed into one, escape it first, and convert
its line breaks to `<br>` if you want to keep them.

## Retries and duplicates

Every JSON-2 call is its own transaction. A timeout does not tell you whether
the server committed: a `create` that timed out may have created the record.
That is why both clients never retry a call by default, and, when `retries` is
set, retry only methods that read (see `READ_ONLY_METHODS`) unless you mark a
call idempotent. If an integration must not create duplicates, give the record
a key you can search for (an external reference field, for example) and search
before you create.
