/**
 * A tiny in-memory whyjuggle.com: enough Laravel behaviour (session cookie,
 * XSRF cookie, CSRF meta token, XHR page envelopes, 419/redirect expiry) to
 * drive the real JuggleClient with NO network. Every fixture value is
 * synthetic.
 */
import { JuggleClient, type JuggleClientOptions } from '../src/client.js';

export const BASE = 'https://juggle.test';
export const EMAIL = 'parent@example.com';
export const PASSWORD = ' s3cret-Pass"word ';

export interface Recorded {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface Reply {
  status?: number;
  body?: string | object;
  headers?: Record<string, string>;
  setCookie?: string[];
}

export type Handler = (req: Recorded, site: FakeSite) => Reply | Promise<Reply>;

export function page(pageName: string, data: object = {}, opts: { user?: object | null; csrf?: string } = {}): object {
  return {
    meta: { page: pageName, csrfToken: opts.csrf ?? 'csrf-after-login', deployedVersion: 'v0.0.0-test' },
    user: opts.user === undefined ? { type: 'family', accountId: 1001, firstName: 'Test' } : opts.user,
    data,
  };
}

/** The HTML a non-XHR page load returns: server-data attribute, entity-encoded. */
export function htmlPage(envelope: object, csrf = 'csrf-html'): string {
  const enc = JSON.stringify(envelope).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><title>Juggle</title><meta name="csrf-token" content="${csrf}"></head><body><div id="app"><app :server-data="${enc}"></app></div></body></html>`;
}

export class FakeSite {
  readonly requests: Recorded[] = [];
  /** Session ids the server currently honours. */
  readonly liveSessions = new Set<string>();
  private nextSession = 1;
  /** What POST /log-in does. */
  loginResult: 'ok' | 'rejected' | 'validation' | 'redirect' | 'server-error' | 'csrf' = 'ok';
  /** Make the sign-in page itself fail. */
  loginPageStatus = 200;
  /** Serve the sign-in page as HTML (meta tag) instead of the XHR JSON envelope. */
  loginPageHtml = false;
  /** After POST /log-in succeeds, GET / still shows signed-out. */
  sessionDoesNotStick = false;
  readonly routes = new Map<string, Handler>();

  on(method: string, path: string, handler: Handler | Reply): this {
    this.routes.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  /** Drop every session, as if they all expired server-side. */
  expireAll(): void {
    this.liveSessions.clear();
  }

  sessionOf(req: Recorded): string | undefined {
    const m = /(?:^|;\s*)whyjuggle_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return m?.[1];
  }

  signedIn(req: Recorded): boolean {
    const s = this.sessionOf(req);
    return s !== undefined && this.liveSessions.has(s);
  }

  count(method: string, path: string): number {
    return this.requests.filter((r) => r.method === method && r.path === path).length;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      search: url.search,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    this.requests.push(rec);
    const reply = await this.handle(rec);
    const h = new Headers(reply.headers);
    for (const c of reply.setCookie ?? []) h.append('set-cookie', c);
    const body = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    if (typeof reply.body === 'object' && !h.has('content-type')) h.set('content-type', 'application/json');
    const status = reply.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : body, { status, headers: h });
  }) as typeof fetch;

  private async handle(req: Recorded): Promise<Reply> {
    if (req.path === '/log-in' && req.method === 'GET') {
      if (this.loginPageStatus !== 200) return { status: this.loginPageStatus, body: 'down' };
      const sid = `pre-${this.nextSession++}`;
      const cookies = [`whyjuggle_session=${sid}; path=/; httponly`, 'XSRF-TOKEN=xsrf%3Dpre; path=/'];
      if (this.loginPageHtml) return { body: htmlPage(page('LogIn', {}, { user: null, csrf: 'csrf-pre' }), 'csrf-pre'), setCookie: cookies };
      return { body: page('LogIn', {}, { user: null, csrf: 'csrf-pre' }), setCookie: cookies };
    }
    if (req.path === '/log-in' && req.method === 'POST') {
      switch (this.loginResult) {
        case 'rejected':
          return { body: { error: true } };
        case 'validation':
          return { status: 422, body: { message: 'The email field is required.', errors: { email: ['The email field is required.'] } } };
        case 'server-error':
          return { status: 503, body: 'maintenance' };
        case 'csrf':
          return { status: 419, body: { message: 'CSRF token mismatch.' } };
        default: {
          const sid = `live-${this.nextSession++}`;
          if (!this.sessionDoesNotStick) this.liveSessions.add(sid);
          const setCookie = [`whyjuggle_session=${sid}; path=/; httponly`, 'XSRF-TOKEN=xsrf%3Dpost; path=/'];
          if (this.loginResult === 'redirect') return { status: 302, headers: { location: '/' }, setCookie };
          return { body: { redirectUrl: '/' }, setCookie };
        }
      }
    }
    const handler = this.routes.get(`${req.method} ${req.path}`);
    if (req.path === '/' && req.method === 'GET' && !handler) {
      if (!this.signedIn(req)) return { status: 302, headers: { location: `${BASE}/log-in` } };
      return { body: page('HomeFamily', { alerts: [] }) };
    }
    if (!handler) return { status: 404, body: { message: 'Not Found' } };
    return handler(req, this);
  }
}

/** Route helper: an authed XHR page; signed-out requests bounce to /log-in. */
export function authedPage(envelope: object | ((req: Recorded) => object)): Handler {
  return (req, site) => {
    if (!site.signedIn(req)) return { status: 302, headers: { location: '/log-in' } };
    return { body: typeof envelope === 'function' ? envelope(req) : envelope };
  };
}

export function makeClient(site: FakeSite, opts: Partial<JuggleClientOptions> = {}): JuggleClient {
  return new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: BASE, fetchImpl: site.fetch, ...opts });
}
