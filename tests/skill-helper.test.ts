/**
 * Executes the shipped skill helper (skills/juggle/scripts/juggle) under bash
 * AND zsh against FakeSite served over loopback HTTP — the shell functions are
 * as easy to ship broken as the requests they wrap. Needs curl + jq on PATH;
 * a shell that is not installed is skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeSite, EMAIL, PASSWORD, authedPage, page } from './helpers.js';
import {
  CANARIES,
  bookingDetailData,
  bookingsData,
  conversationData,
  conversationsData,
  locationsData,
  paymentsData,
  profileData,
  reviewsData,
  sitterDetailData,
  sittersData,
} from './fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'skills/juggle/scripts/juggle');

function has(cmd: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TOOLS_OK = has('curl') && has('jq');
// macOS ships bash 3.2 as /bin/bash; PATH's bash is often a newer Homebrew one.
const SHELLS = ['bash', 'zsh', ...(process.platform === 'darwin' ? ['/bin/bash'] : [])].filter(has);

function buildSite(): FakeSite {
  const site = new FakeSite();
  site
    .on('GET', '/my-profile', authedPage(page('MyProfileFamily', profileData)))
    .on('GET', '/bookings', authedPage(page('Bookings', bookingsData)))
    .on('GET', '/bookings/3001', authedPage(page('BookingDetails', bookingDetailData)))
    .on('GET', '/sitters', authedPage(page('FindASitter', sittersData)))
    .on('GET', '/sitters/1201', authedPage(page('SitterDetails', sitterDetailData)))
    .on('GET', '/reviews/1101', authedPage(page('Reviews', reviewsData(30))))
    .on('GET', '/messages', authedPage(page('Messages', conversationsData)))
    .on('GET', '/messages/4001', authedPage(page('Conversation', conversationData(5))))
    .on('GET', '/payments', authedPage(page('PaymentsFamily', paymentsData)))
    .on('GET', '/locations', { body: page('Locations', locationsData, { user: null }) })
    .on('GET', '/log-out', (_req, s) => {
      s.expireAll();
      return { status: 302, headers: { location: '/' } };
    });
  return site;
}

let site: FakeSite;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      const r = await site.fetch(`https://juggle.test${req.url}`, { method: req.method, headers, body });
      const out: Record<string, string | string[]> = {};
      r.headers.forEach((v, k) => {
        if (k !== 'set-cookie') out[k] = k === 'location' ? v.replace('https://juggle.test', base) : v;
      });
      const cookies = r.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(r.status, out);
      res.end(await r.text());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!TOOLS_OK || SHELLS.length === 0).each(SHELLS)('skill helper under %s', (shell) => {
  let home: string;
  let sessionFile: string;

  function run(args: string[], env: Record<string, string | undefined> = {}, pipeTo?: string): Promise<Run> {
    const fullEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: home,
      JUGGLE_BASE_URL: base,
      JUGGLE_EMAIL: EMAIL,
      JUGGLE_PASSWORD: PASSWORD,
    };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete fullEnv[k];
      else fullEnv[k] = v;
    }
    const [cmd, argv] = pipeTo
      ? [shell, ['-c', `${shell} "$0" "$@" | ${pipeTo}`, SCRIPT, ...args]]
      : [shell, [SCRIPT, ...args]];
    return new Promise((resolve) => {
      execFile(cmd, argv, { env: fullEnv, timeout: 20_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      });
    });
  }

  const json = (r: Run) => JSON.parse(r.stdout);

  beforeEach(() => {
    site = buildSite();
    home = mkdtempSync(join(tmpdir(), 'juggle-skill-'));
    sessionFile = join(home, '.config/juggle/session');
  });

  it('login stores its OWN 0600 session file and sends the password byte-exact', async () => {
    const r = await run(['login']);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r)).toEqual({ signedIn: true, type: 'family', firstName: 'Test' });
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(sessionFile)).mode & 0o777).toBe(0o700);
    const post = site.requests.find((x) => x.method === 'POST' && x.path === '/log-in')!;
    expect(JSON.parse(post.body!)).toEqual({ email: EMAIL, password: PASSWORD });
    expect(post.headers['x-csrf-token']).toBe('csrf-pre');
    expect(r.stdout + r.stderr).not.toContain('s3cret');
  });

  it('a rejected password exits 5 and is posted exactly once', async () => {
    site.loginResult = 'rejected';
    const r = await run(['bookings']);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/rejected/);
    expect(site.count('POST', '/log-in')).toBe(1);
    expect(existsSync(sessionFile)).toBe(false);
  });

  it('missing credentials and no session: exit 6 for reads, 5 for login, no request sent', async () => {
    const r = await run(['bookings'], { JUGGLE_EMAIL: undefined, JUGGLE_PASSWORD: undefined });
    expect(r.code).toBe(6);
    const l = await run(['login'], { JUGGLE_PASSWORD: undefined });
    expect(l.code).toBe(5);
    expect(site.requests).toHaveLength(0);
  });

  it('an expired session re-logs-in once and replays; without credentials it exits 6', async () => {
    expect((await run(['login'])).code).toBe(0);
    site.expireAll();
    const r = await run(['conversations']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/expired/);
    expect(site.count('POST', '/log-in')).toBe(2);
    expect(json(r)[0]).toMatchObject({ conversationId: 4001, unread: 1 });

    site.expireAll();
    const n = await run(['conversations'], { JUGGLE_EMAIL: undefined, JUGGLE_PASSWORD: undefined });
    expect(n.code).toBe(6);
    expect(site.count('POST', '/log-in')).toBe(2);
  });

  it('the login page served in place (200 meta.page LogIn) counts as expired', async () => {
    expect((await run(['login'])).code).toBe(0);
    site.on('GET', '/messages', { body: page('LogIn', {}, { user: null }) });
    const r = await run(['conversations']);
    expect(r.code).toBe(6);
    expect(site.count('POST', '/log-in')).toBe(2);
  });

  it('profile is allowlisted; kids only with --kids', async () => {
    const r = await run(['profile']);
    expect(r.code, r.stderr).toBe(0);
    const p = json(r);
    expect(p).toMatchObject({ fullName: 'Test Parent', serviceArea: 'Charlotte, NC', numKids: 2 });
    expect(p.addresses[0]).toMatchObject({ id: 501, state: 'North Carolina' });
    expect(p.kids).toBeUndefined();
    for (const c of [CANARIES.familyPhone, CANARIES.familyEmergency, CANARIES.houseInstructions, CANARIES.kidAllergy]) {
      expect(r.stdout).not.toContain(c);
    }
    const k = await run(['profile', '--kids']);
    expect(json(k).kids[0]).toMatchObject({ name: 'Kid One', gender: 'Boy' });
  });

  it('bookings filter active / past / all, sorted by start', async () => {
    const active = json(await run(['bookings']));
    expect(active.map((b: { bookingId: number }) => b.bookingId)).toEqual([3002, 3001]);
    expect(active[0]).toMatchObject({ statusLabel: 'Booked', service: 'Babysitting', recurring: { seriesId: 77 } });
    expect(json(await run(['bookings', 'past'])).map((b: { bookingId: number }) => b.bookingId)).toEqual([3004, 3003]);
    expect(json(await run(['bookings', 'all']))).toHaveLength(4);
    expect((await run(['bookings', 'bogus'])).code).toBe(1);
  });

  it('booking detail: applicants, booked sitters, payment, permissions', async () => {
    const b = json(await run(['booking', '3001']));
    expect(b.applicants).toHaveLength(2);
    expect(b.applicants[0]).toMatchObject({ accountId: 1101, profileId: 1201, status: 'pending', isFavorite: 1 });
    expect(b.bookedSitters[0]).toMatchObject({ userId: 1303, name: 'Booked Sitter' });
    expect(b.payment.breakdown).not.toHaveProperty('surgePriceDesc');
    expect(b.can).toEqual({ cancel: true, edit: true, sendMessage: true });
    expect((await run(['booking', '../payments'])).code).toBe(1);
  });

  it('sitters pass filters as query params; favorites use ?favorites=1', async () => {
    const r = await run(['sitters', 'keywords=infant care', 'services[]=petsitting']);
    expect(json(r).sitters[0]).toMatchObject({ profileId: 1201, accountId: 1101, name: 'Test Sitter' });
    const q = new URLSearchParams(site.requests.filter((x) => x.path === '/sitters').at(-1)!.search);
    expect(q.get('keywords')).toBe('infant care');
    expect(q.getAll('services[]')).toEqual(['petsitting']);
    expect(q.get('numSitters')).toBe('20');
    await run(['favorites']);
    const f = new URLSearchParams(site.requests.filter((x) => x.path === '/sitters').at(-1)!.search);
    expect(f.get('favorites')).toBe('1');
  });

  it('a sitter profile never prints the private fields', async () => {
    const r = await run(['sitter', '1201']);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r)).toMatchObject({ profileId: 1201, accountId: 1101, userId: 1301, profile: { college: 'Test University' } });
    for (const c of [CANARIES.sitterPhone, CANARIES.sitterBirthdate, CANARIES.sitterEmergency, CANARIES.sitterEmergencyPhone, CANARIES.facebook]) {
      expect(r.stdout).not.toContain(c);
    }
    expect(r.stdout).not.toMatch(/convicted|maltreatment|disciplinary/);
  });

  it('reviews paginate with totals and an average', async () => {
    const r = json(await run(['reviews', '1101', '5', '10']));
    expect(r).toMatchObject({ reviewedName: 'Test Sitter', total: 30, averageRating: 4.5, offset: 10 });
    expect(r.reviews).toHaveLength(5);
    expect(r.reviews[0].name).toBe('Reviewer 11');
  });

  it('a conversation returns the newest `limit` messages, oldest first', async () => {
    const r = json(await run(['conversation', '4001', '2']));
    expect(r).toMatchObject({ conversationId: 4001, total: 5 });
    expect(r.messages.map((m: { id: number }) => m.id)).toEqual([6003, 6004]);
  });

  it('payments never print the Stripe secret, key or payment-method ids; cents become dollars', async () => {
    const r = await run(['payments']);
    expect(r.code, r.stderr).toBe(0);
    for (const c of [CANARIES.clientSecret, CANARIES.publishableKey, CANARIES.intentId, CANARIES.paymentMethodId]) {
      expect(r.stdout).not.toContain(c);
    }
    const p = json(r);
    expect(p.baseRatesUsd.babysitting1Kid).toBe(20);
    expect(p.paymentMethods[0]).toEqual({ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });
    expect(p.transactions[0]).toMatchObject({ totalUsd: 85, tipUsd: 10 });
  });

  it('locations is public: no sign-in, rate prose as plain text, optional state filter', async () => {
    const r = await run(['locations', 'north carolina'], { JUGGLE_EMAIL: undefined, JUGGLE_PASSWORD: undefined });
    expect(r.code, r.stderr).toBe(0);
    expect(json(r)).toEqual([{ state: 'North Carolina', city: 'Testville', details: 'Email: support@example.com Babysitting Rates: 1 kid—$20/hour' }]);
    expect(site.count('POST', '/log-in')).toBe(0);
  });

  it('get prints the raw envelope but refuses the pages with private raw data', async () => {
    const r = await run(['get', '/bookings']);
    expect(json(r).meta.page).toBe('Bookings');
    for (const route of ['/sitters/1201', '/payments', '/my-profile', '/bookings?x=1', 'bookings']) {
      const x = await run(['get', route]);
      expect(x.code, route).toBe(1);
    }
    expect(site.requests.some((x) => x.path === '/payments' || x.path === '/my-profile' || x.path === '/sitters/1201')).toBe(false);
  });

  it('get refuses routes that curl or the server would normalise onto a refused page', async () => {
    await run(['get', '/bookings']);
    const before = site.requests.length;
    for (const route of [
      '/./payments', '/./my-profile', '/./sitters/1201', '/sitters//1201', '/bookings//x', '/%70ayments',
      '/payments/.', '/bookings/./../payments', '/sitters/%31201', '/sitters\\1201',
      '/Payments', '/MY-PROFILE', '/payments ', '/payments\t', '/sitters/1201;x',
    ]) {
      const x = await run(['get', route]);
      expect(x.code, route).toBe(1);
    }
    expect(site.requests.length).toBe(before);
  });

  it('status and logout', async () => {
    expect(json(await run(['status']))).toEqual({ signedIn: false });
    await run(['login']);
    expect(json(await run(['status']))).toMatchObject({ signedIn: true, type: 'family' });
    expect(json(await run(['logout']))).toEqual({ signedIn: false });
    expect(existsSync(sessionFile)).toBe(false);
  });

  it('refuses a non-https base URL (the password goes there)', async () => {
    const r = await run(['login'], { JUGGLE_BASE_URL: 'http://juggle.example.com' });
    expect(r.code).toBe(1);
    const r2 = await run(['login'], { JUGGLE_BASE_URL: 'http://localhost.evil.example' });
    expect(r2.code).toBe(1);
    expect(site.requests).toHaveLength(0);
  });

  it('piping into something that exits early prints no noise', async () => {
    await run(['login']);
    const r = await run(['bookings', 'all'], {}, 'head -c 1');
    expect(r.stdout).toBe('[');
    expect(r.stderr).toBe('');
  });

  it('an unknown command prints usage and exits 1', async () => {
    const r = await run(['nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/juggle login/);
  });

  it('uses JUGGLE_SESSION_FILE when set', async () => {
    const custom = join(home, 'elsewhere', 'jar');
    const r = await run(['login'], { JUGGLE_SESSION_FILE: custom });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(sessionFile)).toBe(false);
  });
});
