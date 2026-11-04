import { createTestHarness } from '@chrischall/mcp-utils/test';
import { describe, expect, it } from 'vitest';
import { toolRegistrars } from '../src/tools/index.js';
import { bookingsData, conversationsData } from './fixtures.js';
import { FakeSite, makeClient } from './helpers.js';
import { callTool, siteWith } from './tool-harness.js';

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

async function served(): Promise<Listed[]> {
  const client = makeClient(new FakeSite());
  const h = await createTestHarness(async (s) => {
    for (const register of toolRegistrars) await register(s, client);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The decision for every served tool. A new tool fails here until it has one. */
const EXPECTED: Record<string, string> = {
  juggle_get_profile: 'lookup',
  juggle_get_payments_summary: 'lookup',
  juggle_list_bookings: 'whats-on',
  juggle_get_booking: 'lookup',
  juggle_list_sitters: 'lookup',
  juggle_list_favorites: 'lookup',
  juggle_get_sitter: 'lookup',
  juggle_get_reviews: 'lookup',
  juggle_list_conversations: 'whats-new',
  juggle_get_conversation: 'lookup',
  juggle_list_locations: 'lookup',
  juggle_post_job: 'change',
  juggle_accept_sitter: 'change',
  juggle_decline_sitter: 'change',
  juggle_cancel_booking: 'change',
  juggle_send_message: 'send',
  juggle_favorite_sitter: 'change',
  juggle_unfavorite_sitter: 'change',
  juggle_leave_review: 'change',
};

const CANONICAL = ['juggle_list_bookings', 'juggle_list_conversations'];

describe('_meta.mint context-group hints', () => {
  it('every served tool but the healthcheck is hinted per the contract', async () => {
    const tools = await served();
    const hinted = tools.filter((t) => t.name !== 'juggle_healthcheck');
    expect(hinted.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const t of hinted) {
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).every((k) => KEYS.includes(k)), t.name).toBe(true);
      expect(m!.domain, t.name).toBe('family');
      expect(INTENTS, t.name).toContain(m!.intent);
      expect(m!.intent, t.name).toBe(EXPECTED[t.name]);
      const props = t.inputSchema.properties ?? {};
      if (m!.canonical !== undefined) {
        expect(m!.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m!.intent);
        expect(props.view?.enum, t.name).toContain('brief');
      }
      if (m!.subject !== undefined) expect(props, t.name).toHaveProperty(m!.subject as string);
      if (m!.when !== undefined) {
        const w = m!.when as { start: string; end: string };
        expect(props, t.name).toHaveProperty(w.start);
        expect(props, t.name).toHaveProperty(w.end);
      }
      const aliases = (m!.aliases ?? []) as string[];
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a, t.name).toBe(a.toLowerCase());
        expect(a.length, t.name).toBeLessThanOrEqual(40);
      }
    }
  });

  it('the healthcheck joins no group', async () => {
    const hc = (await served()).find((t) => t.name === 'juggle_healthcheck');
    expect(hc).toBeDefined();
    expect(hc!._meta?.mint).toBeUndefined();
  });

  it('has exactly one canonical read per intent it answers, and no subject (one family account, nothing to list)', async () => {
    const tools = await served();
    const canon = tools.filter((t) => t._meta?.mint?.canonical === true);
    expect(canon.map((t) => t.name).sort()).toEqual([...CANONICAL].sort());
    const intents = canon.map((t) => t._meta!.mint!.intent);
    expect(new Set(intents).size).toBe(intents.length);
    for (const t of canon) expect(t._meta!.mint!.subject, t.name).toBeUndefined();
  });

  it('never marks a write canonical', async () => {
    for (const t of await served()) {
      if (t.annotations?.readOnlyHint !== true) expect(t._meta?.mint?.canonical, t.name).toBeUndefined();
    }
  });

  it('only the canonical reads offer view "brief"', async () => {
    for (const t of await served()) {
      const offers = (t.inputSchema.properties?.view?.enum ?? []).includes('brief');
      expect(offers, t.name).toBe(CANONICAL.includes(t.name));
    }
  });
});

type Envelope = { untrusted_content: boolean; note: string; data: string[] };

function envelope(text: string): Envelope {
  const e = JSON.parse(text) as Envelope;
  expect(e.untrusted_content).toBe(true);
  expect(e.note).toMatch(/written by other Juggle users/);
  expect(Array.isArray(e.data)).toBe(true);
  return e;
}

const LINE = /^.+ — (\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?|no date) — .+$/;

function expectBriefLines(lines: string[]): void {
  for (const l of lines) {
    expect(l.length, l).toBeLessThanOrEqual(120);
    if (!l.startsWith('-- ')) expect(l, l).toMatch(LINE);
  }
}

describe('juggle_list_bookings view "brief"', () => {
  const site = (data: object = bookingsData) => siteWith({ '/bookings': ['Bookings', data] });

  it('answers one line per active booking, soonest first, inside the untrusted envelope', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings', { view: 'brief' });
    const e = envelope(r.text);
    expect(e.data).toEqual([
      'Babysitting with Test Sitter — 2026-11-10T17:00 — booked',
      'Babysitting, no sitter yet — 2026-11-20T18:00 — open, 2 applications',
    ]);
    expectBriefLines(e.data);
  });

  it('notes a partial page as "-- N of M shown"', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings', { view: 'brief', status: 'all', limit: 1 });
    const e = envelope(r.text);
    expect(e.data).toEqual(['Babysitting, no sitter yet — 2026-09-01T09:00 — canceled', '-- 1 of 4 shown']);
  });

  it('answers "-- none" when nothing matches', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings', { view: 'brief', service: 'homeschool_help' });
    expect(envelope(r.text).data).toEqual(['-- none']);
  });

  it('keeps a long line within 120 chars by shortening the title, never the date or status', async () => {
    const long = {
      ...bookingsData,
      bookings: [{ ...bookingsData.bookings[1], name: 'A Sitter With An Extraordinarily Long Display Name That Goes On And On And On Forever' }],
    };
    const r = await callTool(makeClient(site(long)), 'juggle_list_bookings', { view: 'brief' });
    const [line] = envelope(r.text).data;
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/… — 2026-11-10T17:00 — booked$/);
  });

  it('answers "no date" and the raw status when a booking lacks them in the label map', async () => {
    const odd = {
      ...bookingsData,
      bookings: [{ ...bookingsData.bookings[0], startDateTime: null, status: 'awaiting_payment', numPendingApplications: 0 }],
    };
    const r = await callTool(makeClient(site(odd)), 'juggle_list_bookings', { view: 'brief' });
    expect(envelope(r.text).data).toEqual(['Babysitting, no sitter yet — no date — awaiting payment']);
  });

  it('leaves the default view unchanged', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings');
    expect(r.json).toMatchObject({ filter: { status: 'active' }, matched: 2 });
  });
});

describe('juggle_list_conversations view "brief"', () => {
  const site = (data: object = conversationsData) => siteWith({ '/messages': ['Messages', data] });

  it('answers the conversations with unread messages by default, one line each, inside the untrusted envelope', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_conversations', { view: 'brief' });
    const e = envelope(r.text);
    expect(e.data).toEqual(['Test Sitter: See you Friday! — 2026-11-01T09:00 — 1 unread']);
    expectBriefLines(e.data);
  });

  it('answers every conversation when unread_only is false', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_conversations', { view: 'brief', unread_only: false });
    expect(envelope(r.text).data).toEqual([
      'Test Sitter: See you Friday! — 2026-11-01T09:00 — 1 unread',
      'Second Sitter: Thanks — 2026-09-02T09:00 — read',
    ]);
  });

  it('collapses a multi-line last message onto one line', async () => {
    const multi = { ...conversationsData, conversations: [{ ...conversationsData.conversations[0], lastMessage: 'See you\n\nFriday!' }] };
    const r = await callTool(makeClient(site(multi)), 'juggle_list_conversations', { view: 'brief' });
    expect(envelope(r.text).data).toEqual(['Test Sitter: See you Friday! — 2026-11-01T09:00 — 1 unread']);
  });

  it('notes a partial page and an empty one', async () => {
    const p = await callTool(makeClient(site()), 'juggle_list_conversations', { view: 'brief', unread_only: false, limit: 1 });
    expect(envelope(p.text).data).toEqual(['Test Sitter: See you Friday! — 2026-11-01T09:00 — 1 unread', '-- 1 of 2 shown']);
    const none = { ...conversationsData, conversations: [conversationsData.conversations[1]] };
    const n = await callTool(makeClient(site(none)), 'juggle_list_conversations', { view: 'brief' });
    expect(envelope(n.text).data).toEqual(['-- none']);
  });
});

describe('registerHintedWrite', () => {
  it('refuses a write with no context-group hint, so a new write cannot ship unhinted', async () => {
    const { registerHintedWrite } = await import('../src/tools/write-kit.js');
    const { defineWrite } = await import('@chrischall/mcp-utils');
    const { z } = await import('zod');
    const h = await createTestHarness((s) => {
      expect(() =>
        registerHintedWrite(
          s,
          defineWrite({
            name: 'juggle_unhinted',
            description: 'x',
            inputSchema: z.object({}),
            plan: () => ({ gate: { action: 'x', summary: 'x', account: undefined, payload: {} }, state: undefined }),
            execute: async () => ({}),
          }),
        ),
      ).toThrow(/no context-group hint/);
    });
    await h.close();
  });
});

describe('withMeta', () => {
  it('changes only registerTool: other properties and methods are the server’s own', async () => {
    const { withMeta, familyMeta } = await import('../src/tools/hints.js');
    const h = await createTestHarness((s) => {
      const view = withMeta(s, familyMeta('lookup'));
      expect(view.server).toBe(s.server);
      expect(view.isConnected()).toBe(s.isConnected());
    });
    await h.close();
  });
});
