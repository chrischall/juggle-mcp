import { decodeHtmlEntities } from '@chrischall/mcp-utils/scrape';

/**
 * The envelope every Juggle page route answers an XHR with — and embeds, HTML-
 * entity-encoded, as `<App :server-data="…">` on a normal page load.
 * Every field the site renders a page from lives under `data`.
 */
export interface JugglePage<D = Record<string, unknown>> {
  meta: JuggleMeta;
  user: JuggleUser | null;
  data: D;
}

export interface JuggleMeta {
  page?: string;
  csrfToken?: string;
  deployedVersion?: string;
  [key: string]: unknown;
}

export interface JuggleUser {
  type?: string;
  accountId?: number | string;
  firstName?: string;
  numUnreadMsgs?: number;
  [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for a `{meta: {...}, ...}` object — the page envelope's minimum. */
export function isPageEnvelope(v: unknown): v is JugglePage {
  return isObject(v) && isObject(v.meta);
}

/** Parse a JSON body; `undefined` when it is not JSON. Never throws. */
export function tryParseJson(body: string): unknown {
  const t = body.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * The page envelope embedded in a full HTML page load (`server-data="…"`),
 * or `undefined`. User text inside it is JSON-escaped and then entity-encoded,
 * so it cannot forge the attribute boundary.
 */
export function parseServerData(html: string): JugglePage | undefined {
  const m = /\bserver-data="([^"]*)"/.exec(html);
  if (!m) return undefined;
  const parsed = tryParseJson(decodeHtmlEntities(m[1]));
  return isPageEnvelope(parsed) ? parsed : undefined;
}

/** The envelope from either an XHR JSON body or an HTML page load. */
export function readPage(body: string): JugglePage | undefined {
  const json = tryParseJson(body);
  if (json !== undefined) return isPageEnvelope(json) ? json : undefined;
  return parseServerData(body);
}

/** `<meta name="csrf-token" content="…">` from an HTML page, if present. */
export function csrfFromHtml(html: string): string | undefined {
  const m = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i.exec(html);
  return m?.[1];
}

/** The login page, identified by the component it renders — not by prose. */
export function isLoginPage(page: JugglePage | undefined): boolean {
  return page?.meta.page === 'LogIn';
}
