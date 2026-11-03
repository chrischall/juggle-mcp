import { CookieJar, fetchBounded } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';

/** What one HTTP hop returns. The body is always read (and bounded). */
export interface JuggleResponse {
  status: number;
  headers: Headers;
  body: string;
  /** The absolute URL this response answered. */
  url: string;
  /** The raw `Location` header of a 3xx, when present. */
  location?: string;
}

export type FetchLike = typeof fetch;

/**
 * The headers the site's own axios instance sends on every request (chunk
 * 2852). `X-Requested-With: XMLHttpRequest` is also what flips a page route
 * from HTML to its `{meta, user, data}` JSON.
 */
export const XHR_HEADERS: Readonly<Record<string, string>> = {
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/plain, */*',
  'X-Client': 'Website',
  'User-Agent': `juggle-mcp/${VERSION} (+https://github.com/chrischall/juggle-mcp)`,
};

/** A page payload is a few hundred KB at most; refuse anything absurd. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Receiver-safe default: calling the bare global `fetch` with `this` bound to
 * a client instance throws "Illegal invocation" on older undici.
 */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface HopRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  jar: CookieJar;
}

/**
 * ONE hop: never follows redirects (so a bounce to /log-in is visible and every
 * hop's Set-Cookie lands in the jar), sends the jar's cookies, absorbs the
 * response's. Timeout covers the body read; the ambient tool-call cancellation
 * is folded in by fetchBounded. Status is not judged here.
 */
export async function hop(req: HopRequest, fetchImpl: FetchLike = defaultFetch): Promise<JuggleResponse> {
  const headers: Record<string, string> = { ...req.headers };
  const cookie = req.jar.header();
  if (cookie) headers.Cookie = cookie;
  const res = await fetchBounded(
    req.url,
    { method: req.method, headers, body: req.body, redirect: 'manual' },
    { fetchImpl, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES, service: 'Juggle', read: 'text' },
  );
  req.jar.absorb(res.headers);
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
    url: req.url,
    location: res.headers.get('location') ?? undefined,
  };
}
