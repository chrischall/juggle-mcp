import {
  CookieJar,
  McpToolError,
  WriteOutcomeUnknownError,
  describeTransportFailure,
  messageOf,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import { CookieSessionManager } from '@chrischall/mcp-utils/session';
import { readConfig, type ConfigInput, type JuggleConfig } from './config.js';
import { JuggleApiError, JuggleCredentialRejectedError, JuggleSessionError } from './errors.js';
import { XHR_HEADERS, defaultFetch, hop, type FetchLike, type JuggleResponse } from './http.js';
import { csrfFromHtml, isLoginPage, readPage, tryParseJson, type JugglePage, type JuggleUser } from './page.js';

/** The live cookie session: the jar plus the CSRF token the site's meta tag carries. */
export interface JuggleSession {
  jar: CookieJar;
  /** Latest `meta.csrfToken` (sent as `X-CSRF-TOKEN`). Refreshed from every page read. */
  csrfToken?: string;
  /** Who the session belongs to, from the post-login page read. */
  user?: JuggleUser | null;
}

export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PageQuery {
  [key: string]: string | number | boolean | readonly (string | number)[] | null | undefined;
}

export interface SendResult<T = unknown> {
  status: number;
  /** The parsed JSON body (`{}` for an empty one). */
  data: T;
}

export interface SendOptions {
  /**
   * Accept a 2xx whose body is not JSON (e.g. an HTML page) as success with
   * `data: {}`. For writes whose response the site's own UI ignores
   * (favorites, reviews). A JSON `{error: true}` is still a refusal.
   */
  anyBody?: boolean;
}

export interface JuggleClientOptions extends ConfigInput {
  fetchImpl?: FetchLike;
}

const LOGIN_PATH = '/log-in';
const MAX_REDIRECTS = 5;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Path of a redirect target, resolved against `base`; `undefined` when unparsable. */
function resolveLocation(location: string, base: string): URL | undefined {
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * Whether a response means "your session is gone": Laravel's 401 / 419 (CSRF
 * or session mismatch), a redirect to /log-in, or the login page itself served
 * in place (XHR JSON whose `meta.page` is `LogIn`, or an HTML page embedding
 * it). Identity of the PAGE, never prose — message bodies are user text.
 */
export function looksExpired(res: JuggleResponse): boolean {
  if (res.status === 401 || res.status === 419) return true;
  if (res.status >= 300 && res.status < 400) {
    const target = res.location ? resolveLocation(res.location, res.url) : undefined;
    return target !== undefined && target.pathname.replace(/\/+$/, '') === LOGIN_PATH;
  }
  if (res.status >= 200 && res.status < 300) return isLoginPage(readPage(res.body));
  return false;
}

/** Laravel validation (`{message, errors:{field:[…]}}`) or Juggle's `{msg}`. */
function serverMessageOf(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const parts: string[] = [];
  if (typeof body.msg === 'string' && body.msg) parts.push(body.msg);
  if (typeof body.message === 'string' && body.message) parts.push(body.message);
  if (isObject(body.errors)) {
    for (const v of Object.values(body.errors)) {
      if (Array.isArray(v)) parts.push(...v.filter((x): x is string => typeof x === 'string'));
    }
  }
  return parts.length ? [...new Set(parts)].join(' ') : undefined;
}

/**
 * Client for whyjuggle.com (Laravel + Vue). Reads go through `getPage()`,
 * which asks a page route for its `{meta, user, data}` JSON; writes go through
 * `send()`, which carries the CSRF headers the site's axios sends. Both ride
 * one cookie session owned by a `CookieSessionManager`: single-flight login,
 * and on an expiry signal exactly one re-login + replay.
 *
 * Deferred config: constructing with no credentials is fine — the error
 * surfaces on the first call that needs a session.
 */
export class JuggleClient {
  readonly baseUrl: string;
  private readonly config: JuggleConfig | null;
  private readonly configError: McpToolError | null;
  private readonly fetchImpl: FetchLike;
  private readonly session: CookieSessionManager<JuggleSession, JuggleResponse>;
  /** Values scrubbed from every error message built from an upstream body. */
  private readonly secrets: string[];

  constructor(opts: JuggleClientOptions = {}) {
    const { config, configError, password } = readConfig(opts);
    this.config = config;
    this.configError = configError;
    this.baseUrl = config?.baseUrl ?? 'https://whyjuggle.com';
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    // Registered here, not after a successful login: a failed sign-in can
    // still raise an error that quotes what was sent.
    this.secrets = password ? [password, JSON.stringify(password).slice(1, -1)] : [];
    this.session = new CookieSessionManager<JuggleSession, JuggleResponse>({
      login: () => this.login(),
      isExpired: looksExpired,
      // A missing config or a rejected password cannot recover without new
      // config — cache it, never re-POST the password.
      isPermanentError: (err) =>
        err instanceof JuggleCredentialRejectedError || (err instanceof McpToolError && err.kind === 'no_credential'),
      // The replay's re-login failing is the actionable error ("password
      // rejected"); surfacing the stale 401 instead would hide it.
      onReplayLoginError: (err) => {
        throw err;
      },
    });
  }

  /**
   * The principal confirm tokens bind to: the sign-in email, lower-cased, or
   * `undefined` when none is configured.
   */
  get account(): string | undefined {
    return this.config?.email.trim().toLowerCase() || undefined;
  }

  /** For the healthcheck: where the credential comes from — never its value. */
  describeCredential(): { source: string | null; detail?: Record<string, unknown> } {
    if (!this.config) return { source: null, detail: this.configError ? { problem: this.configError.message } : undefined };
    const live = this.session.current;
    return {
      source: 'env',
      detail: {
        email: maskEmail(this.config.email),
        site: new URL(this.baseUrl).host,
        session_live: live !== undefined,
        ...(live?.user ? { account_type: live.user.type ?? null } : {}),
      },
    };
  }

  /** Ensure a signed-in session (single-flight login). */
  async ensureSession(): Promise<JuggleSession> {
    return this.session.ensure();
  }

  /**
   * GET a page route as XHR and return its `{meta, user, data}`. Same-origin
   * redirects are followed (each hop's cookies kept); a redirect to /log-in
   * or the login page itself triggers one re-login + replay.
   *
   * `auth: false` reads a PUBLIC page (e.g. /locations) on a throwaway jar
   * without signing in.
   */
  async getPage<D = Record<string, unknown>>(path: string, query?: PageQuery, opts: { auth?: boolean } = {}): Promise<JugglePage<D>> {
    const url = this.url(path, query);
    if (opts.auth === false) {
      const res = await this.transport('GET', () => this.followGet(url, { jar: new CookieJar() }));
      return this.pageFrom(res, 'GET', path) as JugglePage<D>;
    }
    const res = await this.transport('GET', () => this.session.withSession((s) => this.followGet(url, s)));
    const page = this.pageFrom(res, 'GET', path) as JugglePage<D>;
    const current = this.session.current;
    if (current && typeof page.meta.csrfToken === 'string' && page.meta.csrfToken) current.csrfToken = page.meta.csrfToken;
    return page;
  }

  /**
   * GET a JSON API route (e.g. `/web-api/conversations`) that does NOT answer
   * with the page envelope. Returns the parsed body.
   */
  async getJson<T = unknown>(path: string, query?: PageQuery): Promise<T> {
    const url = this.url(path, query);
    const res = await this.transport('GET', () => this.session.withSession((s) => this.followGet(url, s)));
    return this.jsonFrom(res, 'GET', path) as T;
  }

  /**
   * Send a write (JSON body) with the CSRF headers the site's axios sends:
   * `X-CSRF-TOKEN` (the page's meta token) and `X-XSRF-TOKEN` (the decoded
   * `XSRF-TOKEN` cookie). An expiry (401/419/redirect to /log-in) re-logs-in
   * and replays exactly once — safe, because the server refused the first
   * attempt. Never follows a redirect.
   *
   * Throws `JuggleApiError` for a refusal (non-2xx, or 2xx `{error: true}`),
   * and `WriteOutcomeUnknownError` for a 5xx / transport failure after the
   * request went out: the token is spent and a blind retry could double-send.
   */
  async send<T = unknown>(method: WriteMethod, path: string, body?: unknown, opts: SendOptions = {}): Promise<SendResult<T>> {
    const url = this.url(path);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await this.transport(method, () =>
      this.session.withSession((s) =>
        hop(
          {
            method,
            url,
            jar: s.jar,
            headers: {
              ...XHR_HEADERS,
              ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...this.csrfHeaders(s),
            },
            body: payload,
          },
          this.fetchImpl,
        ),
      ),
    );
    if (res.status >= 300 && res.status < 400 && !looksExpired(res)) {
      return { status: res.status, data: { redirect: res.location ?? null } as T };
    }
    return { status: res.status, data: this.jsonFrom(res, method, path, opts.anyBody === true) as T };
  }

  // ---------------------------------------------------------------- internals

  private url(path: string, query?: PageQuery): string {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new McpToolError(`Internal error: Juggle path must be site-relative, got ${JSON.stringify(path)}`);
    }
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          // Laravel's array convention (`services[]=a&services[]=b`).
          for (const v of value) url.searchParams.append(`${key}[]`, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private csrfHeaders(s: JuggleSession): Record<string, string> {
    const headers: Record<string, string> = {};
    if (s.csrfToken) headers['X-CSRF-TOKEN'] = s.csrfToken;
    const xsrf = s.jar.get('XSRF-TOKEN');
    if (xsrf) {
      try {
        headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
      } catch {
        headers['X-XSRF-TOKEN'] = xsrf;
      }
    }
    return headers;
  }

  /** GET with manual same-origin redirect following; stops at a bounce to /log-in. */
  private async followGet(url: string, s: { jar: CookieJar }): Promise<JuggleResponse> {
    let current = url;
    for (let i = 0; ; i++) {
      const res = await hop({ method: 'GET', url: current, jar: s.jar, headers: { ...XHR_HEADERS } }, this.fetchImpl);
      if (res.status < 300 || res.status >= 400 || looksExpired(res) || !res.location) return res;
      const next = resolveLocation(res.location, current);
      if (!next || next.origin !== new URL(this.baseUrl).origin) {
        throw new JuggleApiError(`Juggle redirected off-site (to ${next?.host ?? 'an unparsable location'}); refusing to follow with your session.`, {
          status: res.status,
        });
      }
      if (i >= MAX_REDIRECTS) throw new JuggleApiError('Juggle redirected too many times.', { status: res.status });
      current = next.toString();
    }
  }

  /**
   * Run a request, turning transport-level failures into typed errors. A
   * write whose request may have gone out is WriteOutcomeUnknownError.
   */
  private async transport(method: string, run: () => Promise<JuggleResponse>): Promise<JuggleResponse> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof McpToolError || isAbort(err)) throw err;
      if (method !== 'GET') {
        throw new WriteOutcomeUnknownError('Juggle', method, {
          cause: err,
          hint: 'The request may or may not have reached Juggle. Check the booking / conversation on whyjuggle.com before retrying.',
        });
      }
      throw describeTransportFailure(err, this.baseUrl, 'Juggle') ?? err;
    }
  }

  private redact(text: string): string {
    return truncateErrorMessage(text, 400, { values: this.secrets });
  }

  /** The page envelope of a final response, or a typed error. */
  private pageFrom(res: JuggleResponse, method: string, path: string): JugglePage {
    this.assertOk(res, method, path);
    const page = readPage(res.body);
    if (!page) {
      throw new JuggleApiError(`Juggle answered ${method} ${path} with something other than a page (HTTP ${res.status}).`, {
        status: res.status,
        hint: 'The page may have moved or changed shape. Run juggle_healthcheck; if that passes, the route needs re-mapping (docs/JUGGLE-API.md).',
      });
    }
    return page;
  }

  /**
   * The parsed JSON of a final response (`{}` when empty), or a typed error.
   * `anyBody`: a 2xx that is not JSON (an HTML page) is `{}` rather than an
   * error — for writes whose response the site's own UI ignores.
   */
  private jsonFrom(res: JuggleResponse, method: string, path: string, anyBody = false): unknown {
    this.assertOk(res, method, path);
    if (res.body.trim() === '') return {};
    const json = tryParseJson(res.body);
    if (json === undefined) {
      if (anyBody) return {};
      throw new JuggleApiError(`Juggle answered ${method} ${path} with a non-JSON body (HTTP ${res.status}).`, { status: res.status });
    }
    if (isObject(json) && json.error === true) {
      const msg = serverMessageOf(json);
      throw new JuggleApiError(this.redact(`Juggle refused ${method} ${path}${msg ? `: ${msg}` : '.'}`), {
        status: res.status,
        serverMessage: msg ? this.redact(msg) : undefined,
        hint: 'Juggle reported the request as failed (HTTP 200 with error:true). Nothing was changed; read the message and adjust.',
      });
    }
    return json;
  }

  private assertOk(res: JuggleResponse, method: string, path: string): void {
    if (looksExpired(res)) {
      throw new JuggleSessionError(`Juggle session expired and could not be renewed (${method} ${path}, HTTP ${res.status}).`, res.status);
    }
    if (res.status >= 200 && res.status < 300) return;
    const msg = serverMessageOf(tryParseJson(res.body));
    const detail = msg ? `: ${this.redact(msg)}` : '';
    if (res.status >= 500 && method !== 'GET') {
      throw new WriteOutcomeUnknownError('Juggle', method, {
        cause: new JuggleApiError(`HTTP ${res.status}`, { status: res.status }),
        hint: `Juggle answered HTTP ${res.status}; the change may or may not have been saved. Check on whyjuggle.com before retrying.`,
      });
    }
    const hints: Record<number, string> = {
      403: 'Juggle refused this for your account (403) — it may need a subscription, or belong to another family.',
      404: 'Not found (404) — check the id.',
      422: 'Juggle rejected the input (422) — see the message.',
      429: 'Juggle is rate-limiting (429). Wait a minute and retry.',
    };
    throw new JuggleApiError(`Juggle ${method} ${path} failed: HTTP ${res.status}${detail}`, {
      status: res.status,
      kind: 'http',
      serverMessage: msg ? this.redact(msg) : undefined,
      hint: hints[res.status] ?? (res.status >= 500 ? 'Juggle had a server error. Retry shortly.' : undefined),
    });
  }

  /**
   * GET /log-in → CSRF token + session cookies; POST /log-in {email,password};
   * then GET / to confirm the session and pick up the rotated CSRF token
   * (Laravel regenerates both on login).
   */
  private async login(): Promise<JuggleSession> {
    try {
      return await this.doLogin();
    } catch (err) {
      if (err instanceof McpToolError || isAbort(err)) throw err;
      // A sign-in that could not reach the site is never a write's unknown
      // outcome — make it a typed transport error before send() sees it.
      throw (
        describeTransportFailure(err, this.baseUrl, 'Juggle') ??
        new McpToolError(`Could not reach Juggle to sign in: ${this.redact(messageOf(err))}`, {
          kind: err instanceof Error && err.name === 'RequestTimeoutError' ? 'timeout' : 'transport',
          cause: err,
        })
      );
    }
  }

  private async doLogin(): Promise<JuggleSession> {
    if (!this.config) throw this.configError!;
    const { email, password } = this.config;
    const jar = new CookieJar();
    const loginUrl = this.url(LOGIN_PATH);

    const form = await hop({ method: 'GET', url: loginUrl, jar, headers: { ...XHR_HEADERS } }, this.fetchImpl);
    const csrfToken = readPage(form.body)?.meta.csrfToken ?? csrfFromHtml(form.body);
    if (form.status !== 200 || typeof csrfToken !== 'string' || !csrfToken) {
      throw new JuggleApiError(`Could not open the Juggle sign-in page (HTTP ${form.status}).`, {
        status: form.status,
        hint: 'whyjuggle.com may be down or have changed its sign-in page. Retry shortly.',
      });
    }

    const session: JuggleSession = { jar, csrfToken };
    const res = await hop({
      method: 'POST',
      url: loginUrl,
      jar,
      headers: { ...XHR_HEADERS, 'Content-Type': 'application/json', ...this.csrfHeaders(session) },
      body: JSON.stringify({ email, password }),
    }, this.fetchImpl);
    const json = tryParseJson(res.body);
    if (res.status === 422 || (res.status === 200 && isObject(json) && json.error === true)) {
      const msg = serverMessageOf(json);
      throw new JuggleCredentialRejectedError(this.redact(`Juggle rejected the email/password${msg ? `: ${msg}` : '.'}`));
    }
    if (res.status === 419) {
      throw new JuggleApiError('Juggle refused the sign-in form (HTTP 419, CSRF/session mismatch).', {
        status: 419,
        kind: 'session_expired',
        hint: 'Retry; the sign-in page token went stale.',
      });
    }
    const redirectedOk = res.status >= 300 && res.status < 400 && !looksExpired(res);
    if (!(res.status === 200 || redirectedOk)) {
      const msg = serverMessageOf(json);
      throw new JuggleApiError(this.redact(`Juggle sign-in failed: HTTP ${res.status}${msg ? `: ${msg}` : ''}`), {
        status: res.status,
        hint: res.status === 429 ? 'Too many sign-in attempts — wait a few minutes before retrying.' : 'Retry shortly; if it persists run juggle_healthcheck.',
      });
    }

    // Confirm the session took and read the post-login CSRF token.
    const home = await this.followGet(this.url('/'), session);
    const page = home.status === 200 ? readPage(home.body) : undefined;
    if (!page || !page.user || isLoginPage(page)) {
      throw new JuggleApiError('Juggle accepted the sign-in but the session did not stick (still signed out).', {
        status: home.status,
        kind: 'session_expired',
        hint: 'Retry once. If it persists, the sign-in flow changed — see the live verification checklist in docs/JUGGLE-API.md.',
      });
    }
    if (typeof page.meta.csrfToken === 'string' && page.meta.csrfToken) session.csrfToken = page.meta.csrfToken;
    session.user = page.user;
    return session;
  }

}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** `chris@example.com` → `c***@example.com`: enough to tell accounts apart. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
