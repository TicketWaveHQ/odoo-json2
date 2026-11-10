// The TypeScript client, built to dist/, against the mock Odoo on 127.0.0.1.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  OdooClient,
  OdooAbortError,
  OdooConfigError,
  OdooHttpError,
  OdooNetworkError,
  OdooResponseError,
  OdooTimeoutError,
  READ_ONLY_METHODS,
  VERSION,
  clientFromEnv,
} from "../dist/index.js";
import { DATABASE, KEY, startMockOdoo } from "./mock-odoo.mjs";

let odoo;
before(async () => {
  odoo = await startMockOdoo();
});
after(() => odoo.close());
beforeEach(() => {
  odoo.requests.length = 0;
  odoo.state.handle = null;
  odoo.state.multiDatabase = false;
});

const client = (extra = {}) => new OdooClient({ url: odoo.url, apiKey: KEY, ...extra });
const last = () => odoo.requests.at(-1);

// -- Request shape -------------------------------------------------------

test("a call is POST /json/2/<model>/<method> with the bearer key and a JSON body of named arguments", async () => {
  await client({ database: DATABASE }).call("res.partner", "search_read", { domain: [["is_company", "=", true]], fields: ["name"], limit: 5 });
  const r = last();
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/json/2/res.partner/search_read");
  assert.equal(r.headers.authorization, `bearer ${KEY}`);
  assert.equal(r.headers["x-odoo-database"], DATABASE);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers.accept, "application/json");
  assert.equal(r.headers["user-agent"], `odoo-json2/${VERSION}`);
  assert.deepEqual(r.body, { domain: [["is_company", "=", true]], fields: ["name"], limit: 5 });
});

test("no X-Odoo-Database header unless a database is given, and no ids or context unless there are some", async () => {
  await client().call("res.users", "context_get");
  assert.equal(last().headers["x-odoo-database"], undefined);
  assert.deepEqual(last().body, {});
});

test("the client's context is merged into every call, and the call's own context wins", async () => {
  const c = client({ context: { lang: "en_GB", tz: "Europe/London" } });
  await c.searchRead("res.partner", { fields: ["name"], context: { lang: "fr_FR", active_test: false } });
  assert.deepEqual(last().body.context, { lang: "fr_FR", tz: "Europe/London", active_test: false });
});

test("a custom User-Agent is sent as given", async () => {
  await client({ userAgent: "example-sync/2.1" }).contextGet();
  assert.equal(last().headers["user-agent"], "example-sync/2.1");
});

test("a base URL with a path prefix and a trailing slash is kept, without the slash", async () => {
  const c = new OdooClient({ url: "https://odoo.example.com/odoo/", apiKey: KEY });
  assert.equal(c.url, "https://odoo.example.com/odoo");
});

// -- Helpers -------------------------------------------------------------

test("searchRead and read return Odoo's records as they come", async () => {
  const c = client();
  const rows = await c.searchRead("res.partner", { domain: [["is_company", "=", true]], fields: ["name"] });
  assert.deepEqual(rows, [{ id: 1, name: "Example Ltd" }, { id: 2, name: "Sample Co" }]);
  const [one] = await c.read("res.partner", [1], { fields: ["email"] });
  assert.deepEqual(one, { id: 1, email: "hello@example.com" });
  assert.deepEqual(last().body, { fields: ["email"], ids: [1] });
});

test("search returns ids, search_count a number, and an empty domain is sent when none is given", async () => {
  const c = client();
  assert.deepEqual(await c.search("res.partner"), [1, 2]);
  assert.deepEqual(last().body, { domain: [] });
  assert.deepEqual(await c.search("res.partner", { context: { active_test: false } }), [1, 2, 3]);
  assert.equal(await c.searchCount("res.partner", { domain: [["is_company", "=", true]] }), 2);
});

test("create sends vals_list and resolves to the new ids, for one record or several", async () => {
  const c = client();
  const [id] = await c.create("res.partner", { name: "New Ltd" });
  assert.ok(Number.isInteger(id));
  assert.deepEqual(last().body, { vals_list: [{ name: "New Ltd" }] });
  const ids = await c.create("res.partner", [{ name: "A" }, { name: "B" }]);
  assert.equal(ids.length, 2);
});

test("write sends ids and vals; unlink sends ids", async () => {
  const c = client();
  const [id] = await c.create("res.partner", { name: "Temp" });
  assert.equal(await c.write("res.partner", [id], { email: "temp@example.com" }), true);
  assert.deepEqual(last().body, { ids: [id], vals: { email: "temp@example.com" } });
  assert.equal(await c.unlink("res.partner", [id]), true);
  assert.deepEqual(last().body, { ids: [id] });
});

test("fieldsGet passes allfields and attributes through", async () => {
  const f = await client().fieldsGet("res.partner", { allfields: ["name"], attributes: ["type"] });
  assert.equal(f.name.type, "char");
  assert.deepEqual(last().body, { allfields: ["name"], attributes: ["type"] });
});

test("contextGet returns the key's user id; version() is a GET that sends no key", async () => {
  const c = client({ database: DATABASE });
  assert.equal((await c.contextGet()).uid, 7);
  const v = await c.version();
  assert.equal(v.version, "19.0");
  assert.equal(last().method, "GET");
  assert.equal(last().url, "/web/version");
  assert.equal(last().headers.authorization, undefined);
});

test("invalid model or method names and bad ids are refused before anything is sent", async () => {
  const c = client();
  await assert.rejects(c.call("res.partner/../x", "read"), TypeError);
  await assert.rejects(c.call("res.partner", "read?x=1"), TypeError);
  await assert.rejects(c.read("res.partner", ["1"]), TypeError);
  await assert.rejects(c.unlink("res.partner", [0]), TypeError);
  await assert.rejects(c.create("res.partner", []), TypeError);
  assert.equal(odoo.requests.length, 0);
});

// -- Errors --------------------------------------------------------------

test("a refused key is an OdooHttpError 401 whose message never carries Odoo's text or the key", async () => {
  const c = new OdooClient({ url: odoo.url, apiKey: "ffffffffffffffffffffffffffffffffffffffff" });
  const err = await c.contextGet().catch((e) => e);
  assert.ok(err instanceof OdooHttpError);
  assert.equal(err.status, 401);
  assert.equal(err.exception, "werkzeug.exceptions.Unauthorized");
  assert.equal(err.exceptionName, "Unauthorized");
  assert.equal(err.payload.message, "Invalid apikey");
  assert.match(err.payload.debug, /Traceback/);
  assert.equal(err.model, "res.users");
  assert.equal(err.method, "context_get");
  assert.doesNotMatch(err.message, /Invalid apikey|ffff/);
  assert.doesNotMatch(JSON.stringify(err), /Invalid apikey|Traceback|ffff/, "payload is not enumerable");
});

test("Odoo's exceptions keep their class and status: validation 422, missing record 404, unknown model 404", async () => {
  const c = client();
  const v = await c.create("res.partner", { email: "x@example.com" }).catch((e) => e);
  assert.equal(v.status, 422);
  assert.equal(v.exceptionName, "ValidationError");
  assert.equal(v.payload.message, "The partner name is required.");
  const m = await c.read("res.partner", [999]).catch((e) => e);
  assert.equal(m.status, 404);
  assert.equal(m.exception, "odoo.exceptions.MissingError");
  const n = await c.searchRead("no.such.model").catch((e) => e);
  assert.equal(n.status, 404);
  assert.equal(n.exception, "werkzeug.exceptions.NotFound");
});

test("an AccessError is a 403 with its payload", async () => {
  odoo.state.handle = () => ({
    status: 403,
    body: { name: "odoo.exceptions.AccessError", message: "You are not allowed to modify 'Contact' (res.partner) records.", arguments: [], context: {}, debug: "" },
  });
  const err = await client().write("res.partner", [1], { name: "x" }).catch((e) => e);
  assert.equal(err.status, 403);
  assert.equal(err.exceptionName, "AccessError");
});

test("a non-JSON error body is kept as a short, hidden excerpt", async () => {
  odoo.state.handle = () => ({ status: 502, body: "<html>Bad gateway</html>" });
  const err = await client().searchRead("res.partner").catch((e) => e);
  assert.ok(err instanceof OdooHttpError);
  assert.equal(err.status, 502);
  assert.equal(err.exception, undefined);
  assert.equal(err.payload, undefined);
  assert.match(err.body, /Bad gateway/);
  assert.doesNotMatch(JSON.stringify(err), /Bad gateway/);
});

test("a multi-database server without the database header answers 404 with a page, not JSON", async () => {
  odoo.state.multiDatabase = true;
  const err = await client().contextGet().catch((e) => e);
  assert.equal(err.status, 404);
  assert.match(err.body, /No database is selected/);
  assert.equal((await client({ database: DATABASE }).contextGet()).uid, 7);
});

test("a 200 that is not JSON is an OdooResponseError", async () => {
  odoo.state.handle = () => ({ status: 200, body: "<html>login</html>" });
  const err = await client().searchRead("res.partner").catch((e) => e);
  assert.ok(err instanceof OdooResponseError);
  assert.equal(err.status, 200);
});

test("a redirect is never followed, so the key is never re-sent", async () => {
  const other = await startMockOdoo();
  try {
    odoo.state.handle = () => ({ status: 307, body: "", headers: { Location: `${other.url}/json/2/res.users/context_get` } });
    const err = await client().contextGet().catch((e) => e);
    assert.ok(err instanceof OdooHttpError);
    assert.equal(err.status, 307);
    assert.equal(err.location, `${other.url}/json/2/res.users/context_get`);
    assert.equal(other.requests.length, 0);
  } finally {
    await other.close();
  }
});

test("a slow answer is an OdooTimeoutError, including a body that stalls", async () => {
  odoo.state.handle = () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: [] }), 500));
  const t0 = Date.now();
  const err = await client({ timeoutMs: 100 }).searchRead("res.partner").catch((e) => e);
  assert.ok(err instanceof OdooTimeoutError, String(err));
  assert.ok(Date.now() - t0 < 450);

  odoo.state.handle = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("[1, 2,");
    return "handled";
  };
  const stalled = await client({ timeoutMs: 150 }).search("res.partner").catch((e) => e);
  assert.ok(stalled instanceof OdooTimeoutError, String(stalled));
});

test("the caller's AbortSignal cancels a call, and an aborted signal sends nothing", async () => {
  const ac = new AbortController();
  ac.abort(new Error("stop"));
  await assert.rejects(client().contextGet({ signal: ac.signal }), OdooAbortError);
  assert.equal(odoo.requests.length, 0);

  odoo.state.handle = () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: {} }), 500));
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 50);
  const err = await client().contextGet({ signal: ac2.signal }).catch((e) => e);
  assert.ok(err instanceof OdooAbortError, String(err));
});

test("a refused connection is an OdooNetworkError", async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  const err = await new OdooClient({ url: `http://127.0.0.1:${port}`, apiKey: KEY }).contextGet().catch((e) => e);
  assert.ok(err instanceof OdooNetworkError, String(err));
});

// -- Retries -------------------------------------------------------------

test("no retries by default", async () => {
  odoo.state.handle = () => ({ status: 503, body: "busy" });
  await assert.rejects(client().searchRead("res.partner"), OdooHttpError);
  assert.equal(odoo.requests.length, 1);
});

test("with retries, a read-only method is retried on 503, and create is not", async () => {
  let n = 0;
  odoo.state.handle = () => (++n <= 2 ? { status: 503, body: "busy" } : undefined);
  const c = client({ retries: 2, retryDelayMs: 1 });
  assert.equal((await c.searchRead("res.partner", { domain: [["is_company", "=", true]], fields: ["name"] })).length, 2);
  assert.equal(odoo.requests.length, 3);

  odoo.requests.length = 0;
  odoo.state.handle = () => ({ status: 503, body: "busy" });
  await assert.rejects(c.create("res.partner", { name: "Once" }), OdooHttpError);
  assert.equal(odoo.requests.length, 1, "create is never retried unless the caller says it is idempotent");

  odoo.requests.length = 0;
  await assert.rejects(c.create("res.partner", { name: "Twice" }, {}, { idempotent: true }), OdooHttpError);
  assert.equal(odoo.requests.length, 3);
  assert.ok(READ_ONLY_METHODS.has("search_read") && !READ_ONLY_METHODS.has("create"));
});

test("a 4xx is never retried", async () => {
  odoo.state.handle = () => ({ status: 422, body: { name: "odoo.exceptions.UserError", message: "no" } });
  await assert.rejects(client({ retries: 3, retryDelayMs: 1 }).searchRead("res.partner"), OdooHttpError);
  assert.equal(odoo.requests.length, 1);
});

// -- Configuration -------------------------------------------------------

test("plain http is refused except to loopback, unless explicitly allowed", () => {
  assert.throws(() => new OdooClient({ url: "http://odoo.example.com", apiKey: KEY }), OdooConfigError);
  assert.ok(new OdooClient({ url: "http://odoo.example.com", apiKey: KEY, allowInsecureHttp: true }));
  assert.ok(new OdooClient({ url: "http://localhost:8069", apiKey: KEY }));
  assert.ok(new OdooClient({ url: "http://[::1]:8069", apiKey: KEY }));
});

test("bad options are refused: no key, credentials or a query in the URL, a non-http scheme", () => {
  assert.throws(() => new OdooClient({ url: "https://odoo.example.com", apiKey: " " }), OdooConfigError);
  assert.throws(() => new OdooClient({ url: "https://user:pw@odoo.example.com", apiKey: KEY }), OdooConfigError);
  assert.throws(() => new OdooClient({ url: "https://odoo.example.com/?db=x", apiKey: KEY }), OdooConfigError);
  assert.throws(() => new OdooClient({ url: "ftp://odoo.example.com", apiKey: KEY }), OdooConfigError);
  assert.throws(() => new OdooClient({ url: "not a url", apiKey: KEY }), OdooConfigError);
  assert.throws(() => new OdooClient({ url: "https://odoo.example.com", apiKey: "a\nb" }), OdooConfigError);
});

test("the key is not visible on the client: not enumerable, not in JSON", () => {
  const c = client();
  assert.equal(Object.keys(c).includes("apiKey"), false);
  assert.doesNotMatch(JSON.stringify(c), new RegExp(KEY));
});

test("construction in a browser page is refused unless dangerouslyAllowBrowser is set", () => {
  globalThis.window = {};
  globalThis.document = {};
  try {
    assert.throws(() => client(), OdooConfigError);
    assert.ok(client({ dangerouslyAllowBrowser: true }));
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("clientFromEnv needs ODOO_URL and ODOO_API_KEY; ODOO_DATABASE is optional", () => {
  assert.equal(clientFromEnv({ ODOO_URL: "https://odoo.example.com" }), null);
  const c = clientFromEnv({ ODOO_URL: "https://odoo.example.com", ODOO_API_KEY: KEY, ODOO_DATABASE: DATABASE });
  assert.equal(c.database, DATABASE);
});

test("an injected fetch is used", async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify([5]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const c = new OdooClient({ url: "https://odoo.example.com", apiKey: KEY, fetch: fake });
  assert.deepEqual(await c.create("res.partner", { name: "X" }), [5]);
  assert.equal(seen[0].url, "https://odoo.example.com/json/2/res.partner/create");
  assert.equal(seen[0].init.redirect, "manual");
});
