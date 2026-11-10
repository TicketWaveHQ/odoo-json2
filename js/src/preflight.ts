#!/usr/bin/env node
/**
 * odoo-json2-preflight: prove that a URL, a database and an API key can reach
 * Odoo's JSON-2 API, with harmless read-only calls only.
 *
 *   export ODOO_URL=https://odoo.example.com
 *   export ODOO_DATABASE=example          # only if the server hosts several
 *   read -rs ODOO_API_KEY && export ODOO_API_KEY
 *   npx odoo-json2-preflight [--model res.partner ...]
 *
 * The key is read from the environment only, never from the command line,
 * where it would land in shell history and process listings. It is never
 * printed. Exit code: 0 all checks passed (warnings allowed), 1 a check
 * failed, 2 a usage error.
 */
import { OdooClient, OdooError, OdooHttpError, OdooNetworkError, OdooTimeoutError, VERSION } from "./index.js";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { isTTY?: boolean; write(s: string): boolean };
};

const USAGE = `Usage: odoo-json2-preflight [--url URL] [--database NAME] [--model MODEL ...] [--timeout MS]

Reads ODOO_URL, ODOO_DATABASE and ODOO_API_KEY from the environment. --url and
--database override the first two. There is no flag for the key, on purpose.

Checks: the URL is https, /web/version answers, the key is accepted
(res.users/context_get), whether the key's user is a Settings administrator,
and, for each --model, which of read, write, create and unlink it may do
(has_access). Nothing is created, changed or deleted.
`;

const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
let failures = 0;
const line = (s: string) => process.stdout.write(`${s}\n`);
const pass = (m: string, extra?: string) => line(`  ${paint("32", "PASS")}  ${m}${extra ? `  ${paint("2", extra)}` : ""}`);
const warn = (m: string, why?: string) => line(`  ${paint("33", "WARN")}  ${m}${why ? `\n        ${why}` : ""}`);
const info = (m: string) => line(`  ${paint("2", "INFO")}  ${m}`);
const fail = (m: string, why?: string) => {
  failures++;
  line(`  ${paint("31", "FAIL")}  ${m}${why ? `\n        ${why}` : ""}`);
};

/** Explain a failed call. Odoo's message is shown, truncated; its traceback never is. */
function explain(err: unknown): string {
  if (err instanceof OdooHttpError) {
    const msg = err.payload?.message ? `: ${err.payload.message.slice(0, 300)}` : "";
    const head = `HTTP ${err.status}${err.exception ? ` ${err.exception}` : ""}${msg}`;
    if (err.status === 0 || (err.status >= 300 && err.status < 400)) {
      return `${head}. The URL redirects${err.location ? ` to ${err.location}` : ""}. Use the final URL: redirects are not followed, so that the key is never re-sent.`;
    }
    if (err.status === 401) {
      return `${head}. Odoo refused the key: check that it is a current API key (not a password) for a user of this database. Keys expire.`;
    }
    if (err.status === 404) {
      return `${head}. No JSON-2 endpoint answered: the server may be older than Odoo 19, the URL may have the wrong path, or no database was selected (set ODOO_DATABASE when the server hosts several).`;
    }
    return head;
  }
  if (err instanceof OdooTimeoutError) return "timed out";
  if (err instanceof OdooNetworkError) {
    // Node's fetch reports "fetch failed" and keeps the real reason one level down.
    const c = err.cause as { message?: string; cause?: { code?: string; message?: string } } | undefined;
    const detail = c?.cause?.code ?? c?.cause?.message ?? c?.message;
    return `network error${detail ? `: ${detail}` : ""}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseArgs(argv: string[]): { url?: string; database?: string; models: string[]; timeoutMs: number } | null {
  const out: { url?: string; database?: string; models: string[]; timeoutMs: number } = { models: [], timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") return null;
    else if (a === "--url") out.url = next();
    else if (a === "--database") out.database = next();
    else if (a === "--model") out.models.push(next());
    else if (a === "--timeout") out.timeoutMs = Number(next());
    else if (a === "--key" || a === "--api-key") throw new Error(`${a} is not accepted: put the key in ODOO_API_KEY (read -rs ODOO_API_KEY)`);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!(out.timeoutMs > 0)) throw new Error("--timeout must be a positive number of milliseconds");
  return out;
}

function majorOf(v: { version?: unknown; version_info?: unknown }): number | undefined {
  const first = Array.isArray(v.version_info) ? v.version_info[0] : v.version;
  const m = /(\d+)/.exec(String(first ?? ""));
  return m ? Number(m[1]) : undefined;
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    line(`odoo-json2-preflight: ${(e as Error).message}\n`);
    line(USAGE);
    return 2;
  }
  if (!args) {
    line(USAGE);
    return 0;
  }

  line(`\nodoo-json2 preflight ${VERSION}\n`);
  line("Configuration");
  const url = (args.url ?? process.env.ODOO_URL ?? "").trim();
  const database = (args.database ?? process.env.ODOO_DATABASE ?? "").trim();
  const key = (process.env.ODOO_API_KEY ?? "").trim();
  const missing = [!url && "ODOO_URL", !key && "ODOO_API_KEY"].filter(Boolean);
  if (missing.length) {
    fail(`missing: ${missing.join(", ")}`, "Set them in the environment. Read the key with: read -rs ODOO_API_KEY && export ODOO_API_KEY");
    return 1;
  }
  pass("URL and key present");
  if (!/^[0-9a-f]{40}(?:_oak)?$/.test(key)) {
    warn(
      "the key does not look like one Odoo generated",
      "Odoo 19 generates 40 hexadecimal characters, and Odoo 20 adds \"_oak\". Make sure it is an API key, not a password.",
    );
  }
  if (database) info(`database: ${database} (sent as X-Odoo-Database)`);
  else info("no ODOO_DATABASE: the server must choose the database from the host name");

  let client: OdooClient;
  try {
    client = new OdooClient({ url, apiKey: key, timeoutMs: args.timeoutMs, ...(database ? { database } : {}) });
  } catch (e) {
    fail("the client refused the configuration", e instanceof OdooError ? e.message : String(e));
    return 1;
  }
  if (client.url.startsWith("https://")) pass("URL is https", client.url);
  else warn("URL is plain http to a loopback address", "Fine for a local test server, never for a real one.");

  line("\nServer");
  try {
    const v = await client.version();
    const major = majorOf(v);
    pass("reached /web/version", `server ${String(v.version ?? "unknown")}`);
    if (major !== undefined && major < 19) {
      warn(`server reports Odoo ${major}`, "Odoo documents the JSON-2 API from 19.0. On an older server use its XML-RPC or JSON-RPC API instead.");
    }
  } catch (e) {
    fail("could not reach /web/version", explain(e));
    line("\nCheck ODOO_URL. Everything below depends on it.\n");
    return 1;
  }

  line("\nThe key");
  let uid: number;
  try {
    const ctx = await client.contextGet();
    uid = ctx.uid;
    const extra = [`user id ${uid}`, ctx.lang ? `lang ${String(ctx.lang)}` : "", ctx.tz ? `tz ${String(ctx.tz)}` : ""].filter(Boolean).join(", ");
    pass("the key is accepted (res.users/context_get)", extra);
  } catch (e) {
    fail("the key was not accepted", explain(e));
    line("");
    return 1;
  }

  try {
    const admin = await client.call<boolean>("res.users", "has_group", { ids: [uid], group_ext_id: "base.group_system" });
    if (admin === true) {
      warn("the key's user is a Settings administrator", "Give each integration its own user with only the access it needs. See SECURITY.md.");
    } else pass("the key's user is not a Settings administrator");
  } catch (e) {
    info(`could not check administrator rights: ${explain(e)}`);
  }

  if (args.models.length) line("\nAccess rights (has_access, model level)");
  for (const model of args.models) {
    const seen: string[] = [];
    let broken = false;
    for (const operation of ["read", "write", "create", "unlink"]) {
      try {
        const ok = await client.call<boolean>(model, "has_access", { operation });
        seen.push(`${operation} ${ok === true ? "yes" : "no"}`);
      } catch (e) {
        fail(`${model}: could not check ${operation}`, explain(e));
        broken = true;
        break;
      }
    }
    if (!broken) info(`${model}: ${seen.join(", ")}`);
  }

  line("");
  if (failures === 0) {
    line(`${paint("32", "All checks passed.")} Read any warnings above.\n`);
    return 0;
  }
  line(`${paint("31", `${failures} check${failures === 1 ? "" : "s"} failed.`)}\n`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    line(`odoo-json2-preflight: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
