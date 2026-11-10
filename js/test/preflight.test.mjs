// The preflight CLI, run as a child process against the mock Odoo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { DATABASE, KEY, startMockOdoo } from "./mock-odoo.mjs";

const SCRIPT = fileURLToPath(new URL("../dist/preflight.js", import.meta.url));

let odoo;
before(async () => {
  odoo = await startMockOdoo();
});
after(() => odoo.close());

function run(env, args = []) {
  return new Promise((resolve) => {
    const clean = { PATH: process.env.PATH, NO_COLOR: "1", ...env };
    execFile(process.execPath, [SCRIPT, ...args], { env: clean, timeout: 20_000 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: stdout });
    });
  });
}

test("passes with a good URL, database and key, and never prints the key", async () => {
  const r = await run({ ODOO_URL: odoo.url, ODOO_DATABASE: DATABASE, ODOO_API_KEY: KEY }, ["--model", "res.partner"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS {2}reached \/web\/version {2}server 19\.0/);
  assert.match(r.out, /PASS {2}the key is accepted \(res\.users\/context_get\) {2}user id 7, lang en_GB, tz Europe\/London/);
  assert.match(r.out, /PASS {2}the key's user is not a Settings administrator/);
  assert.match(r.out, /INFO {2}res\.partner: read yes, write yes, create yes, unlink no/);
  assert.match(r.out, /All checks passed/);
  assert.doesNotMatch(r.out, new RegExp(KEY));
});

test("fails with exit 1 and an explanation when the key is refused", async () => {
  const bad = "f".repeat(40);
  const r = await run({ ODOO_URL: odoo.url, ODOO_API_KEY: bad });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}the key was not accepted/);
  assert.match(r.out, /HTTP 401 werkzeug\.exceptions\.Unauthorized: Invalid apikey/);
  assert.doesNotMatch(r.out, new RegExp(bad));
  assert.doesNotMatch(r.out, /Traceback/);
});

test("warns when the key looks like a password, and when its user is an administrator", async () => {
  odoo.state.admin = true;
  try {
    const r = await run({ ODOO_URL: odoo.url, ODOO_API_KEY: "hunter2" });
    assert.equal(r.code, 1, "the mock refuses it too");
    assert.match(r.out, /WARN {2}the key does not look like one Odoo generated/);
    const ok = await run({ ODOO_URL: odoo.url, ODOO_API_KEY: KEY });
    assert.equal(ok.code, 0);
    assert.match(ok.out, /WARN {2}the key's user is a Settings administrator/);
  } finally {
    odoo.state.admin = false;
  }
});

test("explains a missing database on a multi-database server", async () => {
  odoo.state.multiDatabase = true;
  try {
    const r = await run({ ODOO_URL: odoo.url, ODOO_API_KEY: KEY });
    assert.equal(r.code, 1);
    assert.match(r.out, /HTTP 404.*no database was selected/s);
  } finally {
    odoo.state.multiDatabase = false;
  }
});

test("missing configuration and a --key flag are refused", async () => {
  const r = await run({});
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}missing: ODOO_URL, ODOO_API_KEY/);
  const k = await run({}, ["--key", "x"]);
  assert.equal(k.code, 2);
  assert.match(k.out, /--key is not accepted/);
});

test("an unreachable server stops the run early", async () => {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  const r = await run({ ODOO_URL: `http://127.0.0.1:${port}`, ODOO_API_KEY: KEY }, ["--timeout", "2000"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}could not reach \/web\/version\n {8}network error: ECONNREFUSED/);
});

test("an Odoo older than 19 is flagged", async () => {
  const old = await startMockOdoo({ version: { version_info: [17, 0, 0, "final", 0, ""], version: "17.0" } });
  try {
    const r = await run({ ODOO_URL: old.url, ODOO_API_KEY: KEY });
    assert.match(r.out, /WARN {2}server reports Odoo 17/);
  } finally {
    await old.close();
  }
});
