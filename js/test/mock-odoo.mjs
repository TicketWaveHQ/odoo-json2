// A small stand-in for an Odoo server's JSON-2 endpoint, on 127.0.0.1 and an
// ephemeral port. It answers the shapes Odoo 19 and 20 document: a bare JSON
// result on success, and { name, message, arguments, context, debug } with a
// 4xx or 5xx on failure. Nothing here talks to a real network.
import http from "node:http";

export const KEY = "0123456789abcdef0123456789abcdef01234567";
export const DATABASE = "example";

const errorBody = (name, message, status) => ({
  name,
  message,
  arguments: [message, status],
  context: {},
  debug: `Traceback (most recent call last):\n  ...\n${name}: ${message}\n`,
});

export async function startMockOdoo(options = {}) {
  const requests = [];
  const state = {
    // When set, the server hosts several databases and needs X-Odoo-Database.
    multiDatabase: options.multiDatabase ?? false,
    version: options.version ?? { version_info: [19, 0, 0, "final", 0, ""], version: "19.0" },
    admin: options.admin ?? false,
    partners: [
      { id: 1, name: "Example Ltd", is_company: true, email: "hello@example.com", active: true },
      { id: 2, name: "Sample Co", is_company: true, email: false, active: true },
      { id: 3, name: "Archived Person", is_company: false, email: false, active: false },
    ],
    nextId: 100,
    // A per-test override: (req) => undefined to fall through, or a response.
    handle: null,
  };

  const send = (res, status, value, headers = {}) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    res.writeHead(status, { "Content-Type": typeof value === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8", ...headers });
    res.end(text);
  };

  const pick = (rec, fields) => (fields && fields.length ? Object.fromEntries([["id", rec.id], ...fields.map((f) => [f, rec[f] ?? false])]) : { ...rec });

  const matches = (rec, domain, context) => {
    if (context?.active_test !== false && rec.active === false) return false;
    return (domain ?? []).every((leaf) => {
      if (!Array.isArray(leaf)) return true;
      const [field, op, value] = leaf;
      if (op === "=") return rec[field] === value;
      if (op === "ilike") return String(rec[field]).toLowerCase().includes(String(value).replace(/%/g, "").toLowerCase());
      if (op === "in") return value.includes(rec[field]);
      return false;
    });
  };

  function rpc(model, method, body, res) {
    const ids = body.ids ?? [];
    if (model === "res.users") {
      if (method === "context_get") return send(res, 200, { lang: "en_GB", tz: "Europe/London", uid: 7 });
      if (method === "has_group") return send(res, 200, body.group_ext_id === "base.group_system" ? state.admin : true);
    }
    if (method === "has_access") return send(res, 200, body.operation !== "unlink");
    if (model !== "res.partner") {
      return send(res, 404, errorBody("werkzeug.exceptions.NotFound", `the model '${model}' does not exist`, 404));
    }
    switch (method) {
      case "search": {
        const found = state.partners.filter((p) => matches(p, body.domain, body.context));
        return send(res, 200, found.slice(body.offset ?? 0, body.limit ? (body.offset ?? 0) + body.limit : undefined).map((p) => p.id));
      }
      case "search_count":
        return send(res, 200, state.partners.filter((p) => matches(p, body.domain, body.context)).length);
      case "search_read": {
        const found = state.partners.filter((p) => matches(p, body.domain, body.context));
        return send(res, 200, found.slice(0, body.limit ?? found.length).map((p) => pick(p, body.fields)));
      }
      case "read": {
        const missing = ids.filter((id) => !state.partners.some((p) => p.id === id));
        if (missing.length) {
          return send(res, 404, errorBody("odoo.exceptions.MissingError", `Record does not exist or has been deleted. (Record: res.partner(${missing.join(", ")},))`, 404));
        }
        return send(res, 200, ids.map((id) => pick(state.partners.find((p) => p.id === id), body.fields)));
      }
      case "create": {
        if (!Array.isArray(body.vals_list)) {
          return send(res, 422, errorBody("werkzeug.exceptions.UnprocessableEntity", "missing a required argument: 'vals_list'", 422));
        }
        for (const v of body.vals_list) {
          if (!v.name) return send(res, 422, errorBody("odoo.exceptions.ValidationError", "The partner name is required.", 422));
        }
        const newIds = body.vals_list.map((v) => {
          const rec = { id: state.nextId++, active: true, ...v };
          state.partners.push(rec);
          return rec.id;
        });
        return send(res, 200, newIds);
      }
      case "write":
        for (const p of state.partners.filter((x) => ids.includes(x.id))) Object.assign(p, body.vals);
        return send(res, 200, true);
      case "unlink":
        state.partners = state.partners.filter((p) => !ids.includes(p.id));
        return send(res, 200, true);
      case "fields_get":
        return send(res, 200, { name: { type: "char", string: "Name" }, email: { type: "char", string: "Email" } });
      default:
        return send(res, 404, errorBody("werkzeug.exceptions.NotFound", `The method '${method}' does not exist on the model 'res.partner'`, 404));
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = undefined;
      }
      const entry = { method: req.method, url: req.url, headers: req.headers, raw, body };
      requests.push(entry);

      if (state.handle) {
        const out = await state.handle(entry, res);
        if (out === "handled") return;
        if (out) return send(res, out.status, out.body, out.headers);
      }

      if (req.method === "GET" && req.url === "/web/version") return send(res, 200, state.version);

      const m = /^\/json\/2\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
      if (req.method !== "POST" || !m) return send(res, 404, "<html><body>Not Found</body></html>");

      // Database selection, as Odoo does it: without a header on a
      // multi-database server, no database is chosen and the route is unknown.
      const db = req.headers["x-odoo-database"];
      if (state.multiDatabase && db !== DATABASE) {
        return send(res, 404, "<!DOCTYPE html><title>404</title><p>No database is selected and the requested URL was not found in the server-wide controllers.</p>");
      }
      const auth = /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
      if (!auth || auth[1] !== KEY) {
        return send(res, 401, errorBody("werkzeug.exceptions.Unauthorized", "Invalid apikey", 401), { "WWW-Authenticate": "Bearer" });
      }
      if (body === undefined) return send(res, 400, errorBody("werkzeug.exceptions.BadRequest", "could not parse the body as json", 400));
      return rpc(m[1], m[2], body, res);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
