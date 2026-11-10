/**
 * odoo-json2: a small client for Odoo's External JSON-2 API.
 *
 * The API, as documented for Odoo 19.0 and 20.0 ("External JSON-2 API"):
 *
 *   POST <base>/json/2/<model>/<method>
 *   Authorization: bearer <API key>
 *   X-Odoo-Database: <database>          (only where the host does not pick one)
 *   Content-Type: application/json; charset=utf-8
 *
 *   { "ids": [...], "context": {...}, "<argument>": <value>, ... }
 *
 * Every argument is named; there are no positional arguments. A success is a
 * 200 whose body is the method's return value as JSON (a recordset comes back
 * as its list of ids). A failure is a 4xx or 5xx whose body is
 * { name, message, arguments, context, debug }, where `name` is the Python
 * exception's qualified name and `debug` is a server traceback.
 *
 * Every call is its own database transaction on the server, committed on
 * success and rolled back on error.
 *
 * Dependency-free: fetch, AbortController, URL and setTimeout only.
 */

export const VERSION = "0.1.0";

/** An Odoo context, for example `{ lang: "en_GB", active_test: false }`. */
export type Context = Record<string, unknown>;
/** An Odoo domain, for example `[["is_company", "=", true]]`. */
export type Domain = readonly unknown[];
/** Field values for `create` and `write`. */
export type Values = Record<string, unknown>;
/** A record as `read` and `search_read` return it. */
export type OdooRecord = { id: number } & Record<string, unknown>;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OdooClientOptions {
  /** The server's base URL, for example `https://odoo.example.com`. https only, unless loopback. */
  url: string;
  /** An API key for the user the integration acts as. Never a password. */
  apiKey: string;
  /** Sent as `X-Odoo-Database`. Needed only where one server hosts several databases. */
  database?: string;
  /** Deadline for each attempt, including reading the response body. Default 30000. */
  timeoutMs?: number;
  /** Default `odoo-json2/<version>`. Odoo's documentation recommends naming your software. */
  userAgent?: string;
  /** Merged into every call's context; a call's own context wins. */
  context?: Context;
  /**
   * Extra attempts after a network error, a timeout, or HTTP 429, 502, 503 or 504.
   * Default 0. Applied only to read-only methods (see READ_ONLY_METHODS) or to a call
   * made with `{ idempotent: true }`. A create, write or unlink is never retried unless
   * you say so.
   */
  retries?: number;
  /** Base delay between attempts, doubled each time. Default 500. */
  retryDelayMs?: number;
  /** A fetch to use instead of the global one (tests, proxies, instrumentation). */
  fetch?: FetchLike;
  /** Permit plain http to a host that is not loopback. Default false: the key travels in a header. */
  allowInsecureHttp?: boolean;
  /** Permit construction in a page with `window` and `document`. Default false. See SECURITY.md. */
  dangerouslyAllowBrowser?: boolean;
}

export interface CallOptions {
  /** Cancels the call. A cancelled call rejects with OdooAbortError. */
  signal?: AbortSignal;
  /** Overrides the client's timeoutMs for this call. */
  timeoutMs?: number;
  /** Treat this call as safe to repeat, so that `retries` applies to it. */
  idempotent?: boolean;
}

/** The JSON body of one call: the method's named arguments, plus `ids` and `context`. */
export interface CallParams {
  ids?: readonly number[];
  context?: Context;
  [argument: string]: unknown;
}

/** The error object Odoo's JSON-2 endpoint sends with a 4xx or 5xx. */
export interface OdooErrorPayload {
  /** Qualified Python exception name, for example `odoo.exceptions.AccessError`. */
  name?: string;
  /** The exception message. It can quote the values you sent. */
  message?: string;
  arguments?: unknown[];
  context?: Context;
  /** A server traceback. Do not log it where your users' data must not go. */
  debug?: string;
}

/**
 * Methods treated as read-only, so that `retries` applies to them. Chosen by name,
 * not by inspecting the server: a custom module can override one of these to write.
 * For such a model, pass `{ idempotent: false }` on the call.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "check_access",
  "context_get",
  "default_get",
  "fields_get",
  "has_access",
  "has_group",
  "name_search",
  "read",
  "read_group",
  "search",
  "search_count",
  "search_fetch",
  "search_read",
]);

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MODEL_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXCEPTION_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const BODY_EXCERPT = 2000;

// -- Errors --------------------------------------------------------------

function hide(target: object, key: string, value: unknown): void {
  // Non-enumerable, so a structured logger that serialises the error's own
  // properties does not write Odoo's message or traceback by accident.
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: true });
}

/** Base class of everything this client throws, apart from TypeError for invalid arguments. */
export class OdooError extends Error {
  override name = "OdooError";
  /** The model called, when the error belongs to a call. */
  readonly model: string | undefined;
  /** The method called, when the error belongs to a call. */
  readonly method: string | undefined;
  constructor(message: string, options: { model?: string; method?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.model = options.model;
    this.method = options.method;
  }
}

/** The client was constructed with options it refuses (bad URL, plain http, a browser page). */
export class OdooConfigError extends OdooError {
  override name = "OdooConfigError";
}

/**
 * Odoo answered with a status other than 2xx, or with a redirect, which is never followed.
 * `message` never contains Odoo's own message text, which can quote the values sent.
 */
export class OdooHttpError extends OdooError {
  override name = "OdooHttpError";
  /** The HTTP status. 0 for a redirect a browser hides from scripts. */
  readonly status: number;
  /** Qualified exception name from the payload, when it looks like one. */
  readonly exception: string | undefined;
  /** The Location header of a redirect. */
  readonly location: string | undefined;
  /** Odoo's error payload, when the body was one. Non-enumerable. */
  declare readonly payload: OdooErrorPayload | undefined;
  /** The start of a body that was not an Odoo error payload. Non-enumerable. */
  declare readonly body: string | undefined;

  constructor(
    status: number,
    init: {
      model?: string;
      method?: string;
      payload?: OdooErrorPayload;
      body?: string;
      location?: string;
    } = {},
  ) {
    const exception =
      typeof init.payload?.name === "string" && init.payload.name.length <= 200 && EXCEPTION_RE.test(init.payload.name)
        ? init.payload.name
        : undefined;
    const target = init.model && init.method ? `${init.model}/${init.method}` : "request";
    const what =
      status >= 300 && status < 400
        ? `redirect${init.location ? ` to ${init.location}` : ""}, not followed`
        : status === 0
          ? "opaque redirect, not followed"
          : exception ?? "no Odoo error payload";
    super(`Odoo ${target}: HTTP ${status} ${what}`, init);
    this.status = status;
    this.exception = exception;
    this.location = init.location;
    hide(this, "payload", init.payload);
    hide(this, "body", init.body);
  }

  /** The exception's class name without its module, for example `AccessError`. */
  get exceptionName(): string | undefined {
    return this.exception?.split(".").pop();
  }
}

/** The call took longer than its timeout, including reading the body. */
export class OdooTimeoutError extends OdooError {
  override name = "OdooTimeoutError";
}

/** The caller's AbortSignal cancelled the call. `cause` is the signal's reason. */
export class OdooAbortError extends OdooError {
  override name = "OdooAbortError";
}

/** fetch itself failed: DNS, TLS, refused connection, reset. `cause` is fetch's error. */
export class OdooNetworkError extends OdooError {
  override name = "OdooNetworkError";
}

/** A 2xx whose body was not JSON, or a helper got a result of the wrong shape. */
export class OdooResponseError extends OdooError {
  override name = "OdooResponseError";
  readonly status: number;
  /** The start of the body. Non-enumerable. */
  declare readonly body: string | undefined;
  constructor(message: string, status: number, init: { model?: string; method?: string; body?: string } = {}) {
    super(message, init);
    this.status = status;
    hide(this, "body", init.body);
  }
}

// -- Helpers -------------------------------------------------------------

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function hasControlChars(v: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(v);
}

function checkIds(ids: unknown, where: string): readonly number[] {
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new TypeError(`${where}: ids must be an array of positive integers`);
  }
  return ids as readonly number[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OdooNetworkError || err instanceof OdooTimeoutError) return true;
  return err instanceof OdooHttpError && RETRY_STATUSES.has(err.status);
}

function asErrorPayload(v: unknown): OdooErrorPayload | undefined {
  if (!isPlainObject(v) || typeof v.name !== "string") return undefined;
  const p: OdooErrorPayload = { name: v.name };
  if (typeof v.message === "string") p.message = v.message;
  if (Array.isArray(v.arguments)) p.arguments = v.arguments;
  if (isPlainObject(v.context)) p.context = v.context;
  if (typeof v.debug === "string") p.debug = v.debug;
  return p;
}

// -- Client --------------------------------------------------------------

export class OdooClient {
  /** The base URL, without a trailing slash. */
  readonly url: string;
  readonly database: string | undefined;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly userAgent: string;
  private readonly defaultContext: Context;
  private readonly fetchImpl: FetchLike;
  declare private readonly apiKey: string;

  constructor(options: OdooClientOptions) {
    if (!isPlainObject(options)) throw new OdooConfigError("options are required");
    const g = globalThis as { window?: unknown; document?: unknown };
    if (typeof g.window !== "undefined" && typeof g.document !== "undefined" && !options.dangerouslyAllowBrowser) {
      throw new OdooConfigError(
        "refusing to run in a browser page: an Odoo API key there is readable by anyone who loads it. " +
          "Call Odoo from your server. See SECURITY.md.",
      );
    }

    let u: URL;
    try {
      u = new URL(String(options.url ?? "").trim());
    } catch {
      throw new OdooConfigError("url is not a valid absolute URL");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new OdooConfigError("url must be https");
    if (u.protocol === "http:" && !isLoopback(u.hostname) && !options.allowInsecureHttp) {
      throw new OdooConfigError("url must be https: the API key travels in a header (allowInsecureHttp overrides)");
    }
    if (u.username || u.password) throw new OdooConfigError("url must not carry credentials");
    if (u.search || u.hash) throw new OdooConfigError("url must not carry a query or fragment");
    this.url = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;

    const key = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    if (!key) throw new OdooConfigError("apiKey is required");
    if (/\s/.test(key) || hasControlChars(key)) throw new OdooConfigError("apiKey must not contain spaces or control characters");
    hide(this, "apiKey", key);

    const db = options.database === undefined ? "" : String(options.database).trim();
    if (hasControlChars(db)) throw new OdooConfigError("database must not contain control characters");
    this.database = db || undefined;

    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 0;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    if (!(this.timeoutMs > 0)) throw new OdooConfigError("timeoutMs must be positive");
    if (!Number.isInteger(this.retries) || this.retries < 0) throw new OdooConfigError("retries must be a whole number");
    if (!(this.retryDelayMs >= 0)) throw new OdooConfigError("retryDelayMs must not be negative");

    this.userAgent = options.userAgent ?? `odoo-json2/${VERSION}`;
    if (hasControlChars(this.userAgent)) throw new OdooConfigError("userAgent must not contain control characters");
    this.defaultContext = { ...(options.context ?? {}) };

    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof f !== "function") throw new OdooConfigError("no fetch available: pass options.fetch");
    // Unbound global fetch throws "Illegal invocation" in some runtimes.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Never show the key, whatever inspects the client. */
  toJSON(): Record<string, unknown> {
    return { url: this.url, database: this.database, timeoutMs: this.timeoutMs, retries: this.retries };
  }

  /**
   * Call any public model method: POST /json/2/<model>/<method>.
   * `params` is the JSON body: the method's named arguments, plus `ids` for a
   * method on records and `context`. Resolves to the method's return value.
   */
  async call<T = unknown>(model: string, method: string, params: CallParams = {}, options: CallOptions = {}): Promise<T> {
    if (typeof model !== "string" || !MODEL_RE.test(model)) throw new TypeError(`invalid model name: ${JSON.stringify(model)}`);
    if (typeof method !== "string" || !METHOD_RE.test(method)) throw new TypeError(`invalid method name: ${JSON.stringify(method)}`);
    if (!isPlainObject(params)) throw new TypeError("params must be an object of named arguments");

    const { ids, context, ...kwargs } = params;
    const body: Record<string, unknown> = { ...kwargs };
    if (ids !== undefined) body.ids = checkIds(ids, `${model}/${method}`);
    if (context !== undefined && !isPlainObject(context)) throw new TypeError("context must be an object");
    const merged = { ...this.defaultContext, ...(context ?? {}) };
    if (Object.keys(merged).length > 0) body.context = merged;

    const headers: Record<string, string> = {
      Authorization: `bearer ${this.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.database) headers["X-Odoo-Database"] = this.database;

    const retryable = options.idempotent ?? READ_ONLY_METHODS.has(method);
    return this.withRetries(retryable, options, () =>
      this.send<T>(`${this.url}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify(body) }, model, method, options),
    );
  }

  // -- Common calls ------------------------------------------------------

  /** search_read: search, then read, in one transaction. */
  async searchRead<T = OdooRecord>(
    model: string,
    params: { domain?: Domain; fields?: readonly string[]; offset?: number; limit?: number; order?: string; context?: Context; [argument: string]: unknown } = {},
    options?: CallOptions,
  ): Promise<T[]> {
    return this.call<T[]>(model, "search_read", { ...params, domain: params.domain ?? [] }, options);
  }

  /** search: ids of the matching records. */
  async search(
    model: string,
    params: { domain?: Domain; offset?: number; limit?: number; order?: string; context?: Context } = {},
    options?: CallOptions,
  ): Promise<number[]> {
    const r = await this.call<unknown>(model, "search", { ...params, domain: params.domain ?? [] }, options);
    return this.expectIds(r, model, "search");
  }

  /** search_count: the number of matching records. */
  async searchCount(model: string, params: { domain?: Domain; limit?: number; context?: Context } = {}, options?: CallOptions): Promise<number> {
    const r = await this.call<unknown>(model, "search_count", { ...params, domain: params.domain ?? [] }, options);
    if (!Number.isInteger(r)) throw new OdooResponseError("search_count did not return a whole number", 200, { model, method: "search_count" });
    return r as number;
  }

  /** read: the given records' fields (all fields when `fields` is omitted). */
  async read<T = OdooRecord>(
    model: string,
    ids: readonly number[],
    params: { fields?: readonly string[]; load?: string | null; context?: Context } = {},
    options?: CallOptions,
  ): Promise<T[]> {
    return this.call<T[]>(model, "read", { ...params, ids: checkIds(ids, `${model}/read`) }, options);
  }

  /** create: one record or several. Always resolves to the list of new ids. */
  async create(model: string, values: Values | readonly Values[], params: { context?: Context } = {}, options?: CallOptions): Promise<number[]> {
    const list = Array.isArray(values) ? values : [values];
    if (list.length === 0 || !list.every(isPlainObject)) throw new TypeError(`${model}/create: values must be an object or a non-empty array of objects`);
    const r = await this.call<unknown>(model, "create", { ...params, vals_list: list }, options);
    return this.expectIds(r, model, "create");
  }

  /** write: the same values on every given record. Resolves to true. */
  async write(model: string, ids: readonly number[], values: Values, params: { context?: Context } = {}, options?: CallOptions): Promise<boolean> {
    if (!isPlainObject(values)) throw new TypeError(`${model}/write: values must be an object`);
    return this.call<boolean>(model, "write", { ...params, ids: checkIds(ids, `${model}/write`), vals: values }, options);
  }

  /** unlink: delete the given records, all or none. Resolves to true. */
  async unlink(model: string, ids: readonly number[], params: { context?: Context } = {}, options?: CallOptions): Promise<boolean> {
    return this.call<boolean>(model, "unlink", { ...params, ids: checkIds(ids, `${model}/unlink`) }, options);
  }

  /** fields_get: the model's field definitions, keyed by field name. */
  async fieldsGet(
    model: string,
    params: { allfields?: readonly string[]; attributes?: readonly string[]; context?: Context } = {},
    options?: CallOptions,
  ): Promise<Record<string, Record<string, unknown>>> {
    return this.call(model, "fields_get", params, options);
  }

  /**
   * res.users/context_get: the key's own user. The documented way to learn the user id
   * under JSON-2, which has no login step. Odoo 19 and 20 return `uid`, `lang` and `tz`.
   */
  async contextGet(options?: CallOptions): Promise<{ uid: number; lang?: string; tz?: string | false } & Record<string, unknown>> {
    const r = await this.call<unknown>("res.users", "context_get", {}, options);
    if (!isPlainObject(r) || !Number.isInteger(r.uid)) {
      throw new OdooResponseError("context_get did not return a user id", 200, { model: "res.users", method: "context_get" });
    }
    return r as { uid: number } & Record<string, unknown>;
  }

  /** GET /web/version, which needs no key. The key is not sent. */
  async version(options: CallOptions = {}): Promise<{ version: string; version_info: unknown[] } & Record<string, unknown>> {
    return this.withRetries(true, options, () =>
      this.send(`${this.url}/web/version`, { method: "GET", headers: { Accept: "application/json", "User-Agent": this.userAgent } }, undefined, undefined, options),
    );
  }

  // -- Transport ---------------------------------------------------------

  private expectIds(r: unknown, model: string, method: string): number[] {
    if (!Array.isArray(r) || !r.every((id) => Number.isInteger(id))) {
      throw new OdooResponseError(`${method} did not return a list of ids`, 200, { model, method });
    }
    return r as number[];
  }

  private async withRetries<T>(retryable: boolean, options: CallOptions, attempt: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await attempt();
      } catch (err) {
        if (!retryable || n >= this.retries || !isRetryable(err)) throw err;
        try {
          await sleep(this.retryDelayMs * 2 ** n, options.signal);
        } catch (reason) {
          throw new OdooAbortError("cancelled by the caller", { cause: reason });
        }
      }
    }
  }

  private async send<T>(url: string, init: RequestInit, model: string | undefined, method: string | undefined, options: CallOptions): Promise<T> {
    const where = { ...(model ? { model } : {}), ...(method ? { method } : {}) };
    const outer = options.signal;
    if (outer?.aborted) throw new OdooAbortError("cancelled by the caller", { ...where, cause: outer.reason });

    const controller = new AbortController();
    let timedOut = false;
    const ms = options.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort, { once: true });

    const failure = (cause: unknown): OdooError =>
      outer?.aborted
        ? new OdooAbortError("cancelled by the caller", { ...where, cause: outer.reason })
        : timedOut
          ? new OdooTimeoutError(`timed out after ${ms} ms`, { ...where, cause })
          : new OdooNetworkError("network error", { ...where, cause });

    try {
      let res: Response;
      try {
        // The key travels in a header, so a redirect must never re-send it.
        res = await this.fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
      } catch (err) {
        throw failure(err);
      }

      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        const location = res.headers.get("location") ?? undefined;
        await res.body?.cancel().catch(() => {});
        throw new OdooHttpError(res.type === "opaqueredirect" ? 0 : res.status, { ...where, ...(location ? { location } : {}) });
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        throw failure(err);
      }

      if (!res.ok) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON: a proxy's page, or Odoo's "no database selected" page
        }
        const payload = asErrorPayload(parsed);
        throw new OdooHttpError(res.status, { ...where, ...(payload ? { payload } : { body: text.slice(0, BODY_EXCERPT) }) });
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new OdooResponseError("the response was not JSON", res.status, { ...where, body: text.slice(0, BODY_EXCERPT) });
      }
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Build a client from environment variables: ODOO_URL, ODOO_API_KEY and,
 * optionally, ODOO_DATABASE. Returns null when ODOO_URL or ODOO_API_KEY is
 * missing, so an integration can stay off until it is configured.
 */
export function clientFromEnv(
  env: Record<string, string | undefined>,
  options: Omit<OdooClientOptions, "url" | "apiKey" | "database"> = {},
): OdooClient | null {
  const url = (env.ODOO_URL ?? "").trim();
  const apiKey = (env.ODOO_API_KEY ?? "").trim();
  const database = (env.ODOO_DATABASE ?? "").trim();
  if (!url || !apiKey) return null;
  return new OdooClient({ ...options, url, apiKey, ...(database ? { database } : {}) });
}
