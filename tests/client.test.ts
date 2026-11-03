import { describe, expect, it, vi } from 'vitest';
import { McpToolError, WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { JuggleClient, looksExpired, maskEmail } from '../src/client.js';
import { JuggleApiError, JuggleCredentialRejectedError, JuggleSessionError } from '../src/errors.js';
import { BASE, EMAIL, FakeSite, PASSWORD, authedPage, htmlPage, makeClient, page } from './helpers.js';

const bookings = page('Bookings', { bookings: [{ id: 1001, status: 'open' }] });

describe('login', () => {
  it('GETs /log-in for the CSRF token, POSTs {email,password} with it, then confirms via GET /', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    const client = makeClient(site);
    const res = await client.getPage('/bookings');
    expect(res.data).toEqual({ bookings: [{ id: 1001, status: 'open' }] });

    const [form, post, home] = site.requests;
    expect(form).toMatchObject({ method: 'GET', path: '/log-in' });
    expect(form.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(post).toMatchObject({ method: 'POST', path: '/log-in' });
    expect(JSON.parse(post.body!)).toEqual({ email: EMAIL, password: PASSWORD }); // password NOT trimmed
    expect(post.headers['x-csrf-token']).toBe('csrf-pre');
    expect(post.headers['x-xsrf-token']).toBe('xsrf=pre'); // URL-decoded cookie
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.headers.cookie).toContain('whyjuggle_session=pre-');
    expect(home).toMatchObject({ method: 'GET', path: '/' });
    expect(home.headers.cookie).toContain('whyjuggle_session=live-');
  });

  it('reads the CSRF token from the HTML meta tag when /log-in answers HTML', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    site.loginPageHtml = true;
    await makeClient(site).getPage('/bookings');
    expect(site.requests[1].headers['x-csrf-token']).toBe('csrf-pre');
  });

  it('accepts a 302 away from /log-in as a successful sign-in', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    site.loginResult = 'redirect';
    await expect(makeClient(site).getPage('/bookings')).resolves.toMatchObject({ meta: { page: 'Bookings' } });
  });

  it('single-flights concurrent logins', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    const client = makeClient(site);
    await Promise.all([client.getPage('/bookings'), client.getPage('/bookings'), client.getPage('/bookings')]);
    expect(site.count('POST', '/log-in')).toBe(1);
  });

  it('a rejected password is permanent: never re-POSTed, and never echoed', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    site.loginResult = 'rejected';
    const client = makeClient(site);
    const first = await client.getPage('/bookings').catch((e) => e);
    expect(first).toBeInstanceOf(JuggleCredentialRejectedError);
    expect(first.kind).toBe('credential_rejected');
    await expect(client.getPage('/bookings')).rejects.toBeInstanceOf(JuggleCredentialRejectedError);
    expect(site.count('POST', '/log-in')).toBe(1);
    expect(String(first.message) + String(first.hint)).not.toContain(PASSWORD.trim());
  });

  it('a 422 validation answer is a rejected credential, with the server message (password scrubbed)', async () => {
    const site = new FakeSite();
    site.loginResult = 'validation';
    site.on('GET', '/x', authedPage(bookings));
    const err = await makeClient(site).getPage('/x').catch((e) => e);
    expect(err).toBeInstanceOf(JuggleCredentialRejectedError);
    expect(err.message).toContain('The email field is required.');
  });

  it('scrubs the password if the server echoes it back', async () => {
    const site = new FakeSite();
    site.on('GET', '/x', authedPage(bookings));
    site.loginResult = 'validation';
    const client = makeClient(site);
    // Override POST /log-in to echo the password in its message.
    const origFetch = site.fetch;
    const echoing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ message: `bad password ${PASSWORD} for ${EMAIL}` }), { status: 422 });
      }
      return origFetch(input, init);
    }) as typeof fetch;
    const err = await new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: BASE, fetchImpl: echoing })
      .getPage('/x')
      .catch((e) => e);
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).toContain('[REDACTED]');
    void client;
  });

  it('a 419 on the sign-in POST is a retryable error, not a rejected credential', async () => {
    const site = new FakeSite().on('GET', '/x', authedPage(bookings));
    site.loginResult = 'csrf';
    const client = makeClient(site);
    const err = await client.getPage('/x').catch((e) => e);
    expect(err).toBeInstanceOf(JuggleApiError);
    expect(err.status).toBe(419);
    site.loginResult = 'ok';
    await expect(client.getPage('/x')).resolves.toBeTruthy(); // not cached
  });

  it('a 5xx / 429 sign-in is a transient http error', async () => {
    const site = new FakeSite().on('GET', '/x', authedPage(bookings));
    site.loginResult = 'server-error';
    const err = await makeClient(site).getPage('/x').catch((e) => e);
    expect(err).toBeInstanceOf(JuggleApiError);
    expect(err.status).toBe(503);
    expect(err.hint).toMatch(/Retry shortly/);

    const limited = new FakeSite();
    const fetch429 = (async (input: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST' ? new Response('slow down', { status: 429 }) : limited.fetch(input, init)) as typeof fetch;
    const e2 = await new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: BASE, fetchImpl: fetch429 }).getPage('/x').catch((e) => e);
    expect(e2.status).toBe(429);
    expect(e2.hint).toMatch(/Too many sign-in attempts/);
  });

  it('fails clearly when the sign-in page cannot be read', async () => {
    const site = new FakeSite();
    site.loginPageStatus = 503;
    const err = await makeClient(site).getPage('/x').catch((e) => e);
    expect(err).toBeInstanceOf(JuggleApiError);
    expect(err.message).toMatch(/sign-in page/);
    expect(site.count('POST', '/log-in')).toBe(0);
  });

  it('fails when the session does not stick after a 200 sign-in', async () => {
    const site = new FakeSite();
    site.sessionDoesNotStick = true;
    const err = await makeClient(site).getPage('/x').catch((e) => e);
    expect(err).toBeInstanceOf(JuggleApiError);
    expect(err.kind).toBe('session_expired');
    expect(err.message).toMatch(/did not stick/);
  });

  it('turns an unreachable site into a typed transport error', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    }) as typeof fetch;
    const err = await new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: BASE, fetchImpl: boom }).getPage('/x').catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('transport');
  });

  it('wraps a non-fetch-failed throw during sign-in (never a raw error)', async () => {
    const boom = (async () => {
      throw new Error(`weird ${PASSWORD}`);
    }) as typeof fetch;
    const err = await new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: BASE, fetchImpl: boom }).send('POST', '/messages', {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError); // the write never went out
    expect(err.message).not.toContain(PASSWORD);
  });
});

describe('deferred config', () => {
  it('boots with no credentials and throws a no_credential error on use, without any request', async () => {
    vi.stubEnv('JUGGLE_EMAIL', '');
    vi.stubEnv('JUGGLE_PASSWORD', '');
    const site = new FakeSite();
    const client = new JuggleClient({ baseUrl: BASE, fetchImpl: site.fetch });
    const err = await client.getPage('/').catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('no_credential');
    expect(err.message).toBe('JUGGLE_EMAIL and JUGGLE_PASSWORD are not set');
    expect(site.requests).toHaveLength(0);
    expect(client.account).toBeUndefined();
    expect(client.describeCredential().source).toBeNull();
    vi.unstubAllEnvs();
  });

  it('names the single missing variable', async () => {
    vi.stubEnv('JUGGLE_PASSWORD', '');
    const err = await new JuggleClient({ email: EMAIL, baseUrl: BASE, fetchImpl: new FakeSite().fetch }).getPage('/').catch((e) => e);
    expect(err.message).toBe('JUGGLE_PASSWORD is not set');
    vi.unstubAllEnvs();
  });

  it('reads JUGGLE_EMAIL / JUGGLE_PASSWORD / JUGGLE_BASE_URL from the environment, keeping password whitespace', async () => {
    vi.stubEnv('JUGGLE_EMAIL', EMAIL);
    vi.stubEnv('JUGGLE_PASSWORD', PASSWORD);
    vi.stubEnv('JUGGLE_BASE_URL', `${BASE}/ignored/path`);
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    const client = new JuggleClient({ fetchImpl: site.fetch });
    expect(client.baseUrl).toBe(BASE);
    await client.getPage('/bookings');
    expect(JSON.parse(site.requests[1].body!).password).toBe(PASSWORD);
    vi.unstubAllEnvs();
  });

  it('refuses a non-https base URL (the password is sent there) but allows loopback http', async () => {
    const plain = new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: 'http://evil.example', fetchImpl: new FakeSite().fetch });
    const err = await plain.getPage('/').catch((e) => e);
    expect(err.kind).toBe('no_credential');
    expect(err.message).toMatch(/must be https/);
    expect(new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: 'http://127.0.0.1:8080' }).baseUrl).toBe('http://127.0.0.1:8080');
    const garbage = await new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: 'not a url' }).getPage('/').catch((e) => e);
    expect(garbage.message).toMatch(/not a valid URL/);
    const creds = await new JuggleClient({ email: EMAIL, password: PASSWORD, baseUrl: 'https://u:p@juggle.test' }).getPage('/').catch((e) => e);
    expect(creds.message).toMatch(/must not carry credentials/);
  });

  it('defaults to https://whyjuggle.com', () => {
    vi.stubEnv('JUGGLE_BASE_URL', '');
    expect(new JuggleClient({ email: EMAIL, password: PASSWORD }).baseUrl).toBe('https://whyjuggle.com');
    vi.unstubAllEnvs();
  });
});

describe('getPage', () => {
  it('sends the XHR headers and returns {meta,user,data}', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    const res = await makeClient(site).getPage('/bookings');
    expect(res.meta.page).toBe('Bookings');
    expect(res.user?.type).toBe('family');
    const req = site.requests.at(-1)!;
    expect(req.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(req.headers.accept).toContain('application/json');
    expect(req.headers['x-client']).toBe('Website');
  });

  it('encodes query params, arrays in Laravel form, skipping null/undefined', async () => {
    const site = new FakeSite().on('GET', '/sitters', authedPage(page('FindASitter', { sitters: [] })));
    await makeClient(site).getPage('/sitters', { sittingDate: '2026-11-10', services: ['babysitting', 'petsitting'], name: undefined, keywords: null, numSitters: 20 });
    const q = new URLSearchParams(site.requests.at(-1)!.search);
    expect(q.get('sittingDate')).toBe('2026-11-10');
    expect(q.getAll('services[]')).toEqual(['babysitting', 'petsitting']);
    expect(q.has('name')).toBe(false);
    expect(q.has('keywords')).toBe(false);
    expect(q.get('numSitters')).toBe('20');
  });

  it('parses an HTML page load (server-data) when the route ignores the XHR header', async () => {
    const site = new FakeSite().on('GET', '/faqs', { body: htmlPage(page('Faqs', { family: [{ question: 'Q?', answer: '<p>A & B</p>' }] })) });
    const res = await makeClient(site).getPage('/faqs', undefined, { auth: false });
    expect(res.data).toEqual({ family: [{ question: 'Q?', answer: '<p>A & B</p>' }] });
  });

  it('reads a public page WITHOUT signing in', async () => {
    const site = new FakeSite().on('GET', '/locations', { body: page('Locations', { states: {} }, { user: null }) });
    const res = await makeClient(site).getPage('/locations', undefined, { auth: false });
    expect(res.meta.page).toBe('Locations');
    expect(site.count('POST', '/log-in')).toBe(0);
  });

  it('keeps the CSRF token fresh from every page read', async () => {
    let n = 0;
    const site = new FakeSite()
      .on('GET', '/bookings', authedPage(() => page('Bookings', {}, { csrf: `csrf-${++n}` })))
      .on('POST', '/favorites/1001', (req) => ({ body: { seen: req.headers['x-csrf-token'] } }));
    const client = makeClient(site);
    await client.getPage('/bookings');
    await client.getPage('/bookings');
    const res = await client.send('POST', '/favorites/1001');
    expect(res.data).toEqual({ seen: 'csrf-2' });
  });

  it('follows same-origin redirects, refuses off-origin ones and loops', async () => {
    const site = new FakeSite()
      .on('GET', '/old', { status: 301, headers: { location: '/bookings' } })
      .on('GET', '/bookings', authedPage(bookings))
      .on('GET', '/away', { status: 302, headers: { location: 'https://evil.example/steal' } })
      .on('GET', '/loop', { status: 302, headers: { location: '/loop' } })
      .on('GET', '/nowhere', { status: 302 });
    const client = makeClient(site);
    await expect(client.getPage('/old')).resolves.toMatchObject({ meta: { page: 'Bookings' } });
    const off = await client.getPage('/away').catch((e) => e);
    expect(off).toBeInstanceOf(JuggleApiError);
    expect(off.message).toMatch(/off-site.*evil\.example/);
    expect(site.requests.some((r) => r.path === '/steal')).toBe(false);
    await expect(client.getPage('/loop')).rejects.toThrow(/too many times/);
    await expect(client.getPage('/nowhere')).rejects.toThrow(/failed: HTTP 302/);
  });

  it('refuses a non-site-relative path', async () => {
    const client = makeClient(new FakeSite());
    await expect(client.getPage('https://evil.example/x')).rejects.toThrow(/site-relative/);
    await expect(client.getPage('//evil.example/x')).rejects.toThrow(/site-relative/);
  });

  it('maps HTTP errors to typed errors with hints', async () => {
    const site = new FakeSite()
      .on('GET', '/forbidden', { status: 403, body: { message: 'Subscription required.' } })
      .on('GET', '/boom', { status: 500, body: 'oops' })
      .on('GET', '/teapot', { status: 418, body: '' })
      .on('GET', '/notjson', authedPage({}))
      .on('GET', '/text', { body: 'plain text' });
    const client = makeClient(site);
    const forbidden = await client.getPage('/forbidden').catch((e) => e);
    expect(forbidden).toMatchObject({ status: 403, serverMessage: 'Subscription required.' });
    expect(forbidden.hint).toMatch(/subscription/);
    const missing = await client.getPage('/missing').catch((e) => e);
    expect(missing).toMatchObject({ status: 404 });
    expect(missing.hint).toMatch(/check the id/);
    const boom = await client.getPage('/boom').catch((e) => e);
    expect(boom).toBeInstanceOf(JuggleApiError); // a GET 5xx is not an unknown-outcome write
    expect(boom.hint).toMatch(/server error/);
    const teapot = await client.getPage('/teapot').catch((e) => e);
    expect(teapot.hint).toBeUndefined();
    await expect(client.getPage('/notjson')).rejects.toThrow(/other than a page/);
    await expect(client.getPage('/text')).rejects.toThrow(/other than a page/);
  });
});

describe('session expiry: exactly one re-login + replay', () => {
  it.each([
    ['a redirect to /log-in', { status: 302, headers: { location: '/log-in' } }],
    ['a 401', { status: 401, body: { message: 'Unauthenticated.' } }],
    ['a 419', { status: 419, body: { message: 'CSRF token mismatch.' } }],
    ['the login page served in place (XHR JSON)', { body: page('LogIn', {}, { user: null }) }],
    ['the login page served in place (HTML)', { body: htmlPage(page('LogIn', {}, { user: null })) }],
    // What whyjuggle.com actually answers a signed-out / stale-cookie XHR with (live 2026-11-03).
    ['the XHR redirect envelope to /log-in', { body: { redirect: true, url: '/log-in', screen: 'LogIn', data: [] } }],
  ])('recovers from %s', async (_label, expiredReply) => {
    const site = new FakeSite().on('GET', '/bookings', (req, s) => (s.signedIn(req) ? { body: bookings } : expiredReply));
    const client = makeClient(site);
    await client.getPage('/bookings');
    site.expireAll();
    await expect(client.getPage('/bookings')).resolves.toMatchObject({ meta: { page: 'Bookings' } });
    expect(site.count('POST', '/log-in')).toBe(2);
    expect(site.count('GET', '/bookings')).toBe(3); // ok, expired, replayed
  });

  it('does not loop: a persistent expiry surfaces as a session error after ONE replay', async () => {
    const site = new FakeSite().on('GET', '/bookings', { status: 302, headers: { location: '/log-in' } });
    const err = await makeClient(site).getPage('/bookings').catch((e) => e);
    expect(err).toBeInstanceOf(JuggleSessionError);
    expect(err.kind).toBe('session_expired');
    expect(site.count('GET', '/bookings')).toBe(2);
    expect(site.count('POST', '/log-in')).toBe(2);
  });

  it('surfaces the re-login failure (e.g. a password changed meanwhile) instead of the stale 401', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    const client = makeClient(site);
    await client.getPage('/bookings');
    site.expireAll();
    site.loginResult = 'rejected';
    await expect(client.getPage('/bookings')).rejects.toBeInstanceOf(JuggleCredentialRejectedError);
  });

  it('replays a write refused with 419 exactly once, with the NEW session and tokens', async () => {
    const site = new FakeSite()
      .on('GET', '/bookings', authedPage(bookings))
      .on('POST', '/messages', (req, s) =>
        s.signedIn(req) ? { body: { messages: [{ id: 1, content: 'hi' }] } } : { status: 419, body: { message: 'CSRF token mismatch.' } },
      );
    const client = makeClient(site);
    await client.getPage('/bookings');
    site.expireAll();
    const res = await client.send('POST', '/messages', { conversationId: 1001, type: 'text', content: 'hi' });
    expect(res.data).toEqual({ messages: [{ id: 1, content: 'hi' }] });
    const posts = site.requests.filter((r) => r.path === '/messages');
    expect(posts).toHaveLength(2);
    expect(posts[0].headers.cookie).not.toBe(posts[1].headers.cookie);
    expect(posts[1].body).toBe(posts[0].body);
  });

  it('looksExpired ignores ordinary redirects and non-2xx bodies', () => {
    const base = { headers: new Headers(), url: `${BASE}/x`, body: '' };
    expect(looksExpired({ ...base, status: 302, location: '/bookings' })).toBe(false);
    expect(looksExpired({ ...base, status: 302 })).toBe(false);
    expect(looksExpired({ ...base, status: 302, location: 'http://[bad' })).toBe(false);
    expect(looksExpired({ ...base, status: 302, location: '/log-in/' })).toBe(true);
    expect(looksExpired({ ...base, status: 500, body: JSON.stringify(page('LogIn')) })).toBe(false);
    // The XHR redirect envelope counts only when it points at the login page.
    expect(looksExpired({ ...base, status: 200, body: JSON.stringify({ redirect: true, url: '/log-in', screen: 'LogIn', data: [] }) })).toBe(true);
    expect(looksExpired({ ...base, status: 200, body: JSON.stringify({ redirect: true, url: 'https://whyjuggle.com/log-in/' }) })).toBe(true);
    expect(looksExpired({ ...base, status: 200, body: JSON.stringify({ redirect: true, url: '/bookings', screen: 'Bookings' }) })).toBe(false);
    expect(looksExpired({ ...base, status: 200, body: JSON.stringify({ redirect: false, url: '/log-in' }) })).toBe(false);
    // A message whose TEXT mentions the login page is not the login page.
    expect(looksExpired({ ...base, status: 200, body: JSON.stringify(page('Conversation', { messages: [{ content: '"page":"LogIn" log-in' }] })) })).toBe(false);
    expect(looksExpired({ ...base, status: 200, body: htmlPage(page('Conversation', { messages: [{ content: 'server-data="{&quot;meta&quot;:{&quot;page&quot;:&quot;LogIn&quot;}}"' }] })) })).toBe(false);
  });
});

describe('send', () => {
  it('sends JSON with the CSRF headers the SPA uses', async () => {
    const site = new FakeSite().on('PATCH', '/bookings/1001/accept-sitter/2002', (req) => ({ body: { status: 'booked', got: req.body } }));
    const res = await makeClient(site).send('PATCH', '/bookings/1001/accept-sitter/2002', { forAll: false });
    expect(res).toEqual({ status: 200, data: { status: 'booked', got: '{"forAll":false}' } });
    const req = site.requests.at(-1)!;
    expect(req.headers['x-csrf-token']).toBe('csrf-after-login'); // rotated by the post-login read
    expect(req.headers['x-xsrf-token']).toBe('xsrf=post');
    expect(req.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('sends no body or content-type when there is no payload, and maps an empty 2xx to {}', async () => {
    const site = new FakeSite().on('DELETE', '/favorites/2002', { status: 204 });
    const res = await makeClient(site).send('DELETE', '/favorites/2002');
    expect(res).toEqual({ status: 204, data: {} });
    const req = site.requests.at(-1)!;
    expect(req.body).toBeUndefined();
    expect(req.headers['content-type']).toBeUndefined();
  });

  it('treats 200 {error:true, msg} as a refusal carrying the server message', async () => {
    const site = new FakeSite()
      .on('POST', '/bookings', { body: { error: true, msg: 'Start time is in the past.' } })
      .on('POST', '/bare', { body: { error: true } });
    const client = makeClient(site);
    const err = await client.send('POST', '/bookings', {}).catch((e) => e);
    expect(err).toBeInstanceOf(JuggleApiError);
    expect(err.serverMessage).toBe('Start time is in the past.');
    expect(err.message).toContain('Start time is in the past.');
    const bare = await client.send('POST', '/bare', {}).catch((e) => e);
    expect(bare.message).toBe('Juggle refused POST /bare.');
    expect(bare.serverMessage).toBeUndefined();
  });

  it('anyBody: a non-JSON 2xx is {} (the UI ignores it); without it, a typed error; {error:true} still refuses', async () => {
    const site = new FakeSite()
      .on('POST', '/favorites/2002', { body: '<html>ok</html>', headers: { 'content-type': 'text/html' } })
      .on('POST', '/reviews/1001/2002', { body: { error: true, msg: 'Already reviewed.' } });
    const client = makeClient(site);
    expect(await client.send('POST', '/favorites/2002', undefined, { anyBody: true })).toEqual({ status: 200, data: {} });
    await expect(client.send('POST', '/favorites/2002')).rejects.toThrow(/non-JSON/);
    await expect(client.send('POST', '/reviews/1001/2002', {}, { anyBody: true })).rejects.toThrow(/Already reviewed/);
  });

  it('reports a 422 with the Laravel validation messages', async () => {
    const site = new FakeSite().on('POST', '/reviews/1001/2002', {
      status: 422,
      body: { message: 'The given data was invalid.', errors: { rating: ['The rating must be at least 0.'], other: 'x' } },
    });
    const err = await makeClient(site).send('POST', '/reviews/1001/2002', { rating: -1 }).catch((e) => e);
    expect(err).toBeInstanceOf(JuggleApiError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('The rating must be at least 0.');
  });

  it('a 5xx after sending is an UNKNOWN outcome, never a plain retryable error', async () => {
    const site = new FakeSite().on('POST', '/messages', { status: 502, body: 'bad gateway' });
    const err = await makeClient(site).send('POST', '/messages', { content: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(site.count('POST', '/messages')).toBe(1); // not replayed
  });

  it('a transport failure on a write is an UNKNOWN outcome', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    const client = makeClient(site, {
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH') throw new TypeError('fetch failed');
        return site.fetch(input, init);
      }) as typeof fetch,
    });
    await client.getPage('/bookings');
    await expect(client.send('PATCH', '/bookings/1001/cancel', {})).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('a transport failure on a read is a typed transport error (or rethrown)', async () => {
    const site = new FakeSite().on('GET', '/bookings', authedPage(bookings));
    let fail: unknown = null;
    const client = makeClient(site, {
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (fail && String(input).includes('/bookings')) throw fail;
        return site.fetch(input, init);
      }) as typeof fetch,
    });
    await client.getPage('/bookings');
    fail = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const err = await client.getPage('/bookings').catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('transport');
    fail = new RangeError('odd');
    await expect(client.getPage('/bookings')).rejects.toBeInstanceOf(RangeError);
    fail = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(client.getPage('/bookings')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns a non-login redirect instead of following it', async () => {
    const site = new FakeSite()
      .on('POST', '/reviews/1001/2002', { status: 302, headers: { location: '/bookings/1001' } })
      .on('POST', '/nolocation', { status: 303 });
    const client = makeClient(site);
    await expect(client.send('POST', '/reviews/1001/2002', { rating: 5 })).resolves.toEqual({ status: 302, data: { redirect: '/bookings/1001' } });
    await expect(client.send('POST', '/nolocation', {})).resolves.toEqual({ status: 303, data: { redirect: null } });
    expect(site.requests.some((r) => r.path === '/bookings/1001')).toBe(false);
  });

  it('rejects a non-JSON 2xx', async () => {
    const site = new FakeSite().on('POST', '/x', { body: '<html>nope</html>' });
    await expect(makeClient(site).send('POST', '/x', {})).rejects.toThrow(/non-JSON/);
  });

  it('passes an undecodable XSRF cookie through verbatim', async () => {
    const site = new FakeSite().on('POST', '/x', (req) => ({ body: { xsrf: req.headers['x-xsrf-token'] } }));
    const client = makeClient(site);
    const s = await client.ensureSession();
    s.jar.absorb(['XSRF-TOKEN=%E0%A4%A; path=/']);
    const res = await client.send('POST', '/x', {});
    expect(res.data).toEqual({ xsrf: '%E0%A4%A' });
  });
});

describe('getJson', () => {
  it('returns a JSON API body as-is', async () => {
    const site = new FakeSite().on('GET', '/web-api/conversations', (req, s) =>
      s.signedIn(req) ? { body: { data: [{ id: 1001 }] } } : { status: 401, body: { message: 'Unauthenticated.' } },
    );
    await expect(makeClient(site).getJson('/web-api/conversations', { include_archived: 1 })).resolves.toEqual({ data: [{ id: 1001 }] });
    expect(site.requests.at(-1)!.search).toBe('?include_archived=1');
  });
});

describe('identity', () => {
  it('binds confirm tokens to the lower-cased email and describes the credential without its value', async () => {
    const site = new FakeSite();
    const client = makeClient(site, { email: 'Parent@Example.com' });
    expect(client.account).toBe('parent@example.com');
    expect(client.describeCredential()).toEqual({
      source: 'env',
      detail: { email: 'P***@Example.com', site: 'juggle.test', session_live: false },
    });
    await client.ensureSession();
    const after = client.describeCredential();
    expect(after.detail).toMatchObject({ session_live: true, account_type: 'family' });
    expect(JSON.stringify(after)).not.toContain(PASSWORD.trim());
  });

  it('reports a null account type when the user has none', async () => {
    const site = new FakeSite().on('GET', '/', authedPage(page('HomeFamily', {}, { user: { accountId: 1 } })));
    const client = makeClient(site);
    await client.ensureSession();
    expect(client.describeCredential().detail).toMatchObject({ account_type: null });
  });

  it('masks emails', () => {
    expect(maskEmail('a@b.c')).toBe('a***@b.c');
    expect(maskEmail('nobody')).toBe('***');
  });
});
