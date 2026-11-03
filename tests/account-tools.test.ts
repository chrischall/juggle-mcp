import { describe, expect, it } from 'vitest';
import { CANARIES, paymentsData, profileData } from './fixtures.js';
import { callTool, makeClient, siteWith } from './tool-harness.js';

const allCanaries = (text: string) => Object.values(CANARIES).filter((c) => text.includes(c));

describe('juggle_get_profile', () => {
  const site = () => siteWith({ '/my-profile': ['MyProfileFamily', profileData] });

  it('returns the allowlisted profile — no phone, emergency contact, house instructions or kids by default', async () => {
    const s = site();
    for (const view of ['compact', 'full', 'raw']) {
      const r = await callTool(makeClient(s), 'juggle_get_profile', { view });
      expect(r.isError, view).toBe(false);
      expect(allCanaries(r.text), view).toEqual([]);
      expect(r.text, view).not.toContain('Kid One');
      expect(r.json.numKids, view).toBe(2);
      expect(r.json.fullName, view).toBe('Test Parent');
    }
  });

  it('compact carries the account basics, stats and address ids (for posting a sit)', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_profile');
    expect(r.json).toMatchObject({
      accountId: 1001,
      email: 'parent@example.com',
      serviceArea: 'Charlotte, NC',
      stats: { jobsPosted: 12, jobsCompleted: 9, jobsCanceled: 1, rating: 5 },
      numKids: 2,
    });
    expect(r.json.addresses).toEqual([
      { id: 501, address: '1 Test St, Testville, North Carolina 28200', primary: true },
      { id: 502, address: '2 Other Rd, Testville, North Carolina 28201', primary: false },
    ]);
    expect(r.json.pets).toEqual([{ name: 'Test Dog', type: 'Dog' }]);
  });

  it('include_kids adds the kids (with allergies) — and still never the phone numbers', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_profile', { include_kids: true, view: 'full' });
    const kids = r.json.kids as Record<string, unknown>[];
    expect(kids).toHaveLength(2);
    expect(kids[0]).toMatchObject({ id: 701, name: 'Kid One', birthday: '2018-05-01', gender: 'Boy', allergies: CANARIES.kidAllergy });
    expect(r.text).not.toContain(CANARIES.familyPhone);
    expect(r.text).not.toContain(CANARIES.houseInstructions);
  });

  it('reads /my-profile as XHR and sends no view on the wire', async () => {
    const s = site();
    await callTool(makeClient(s), 'juggle_get_profile', { view: 'full' });
    const req = s.requests.find((q) => q.path === '/my-profile')!;
    expect(req.search).toBe('');
    expect(req.headers['x-requested-with']).toBe('XMLHttpRequest');
  });
});

describe('juggle_get_payments_summary', () => {
  const site = () => siteWith({ '/payments': ['PaymentsFamily', paymentsData] });

  it('never returns the Stripe SetupIntent, publishable key or payment-method ids — on any rung', async () => {
    for (const view of ['compact', 'full', 'raw']) {
      const r = await callTool(makeClient(site()), 'juggle_get_payments_summary', { view });
      expect(r.isError, view).toBe(false);
      expect(allCanaries(r.text), view).toEqual([]);
      expect(r.text, view).not.toMatch(/client_secret|publishableKey|intent|stripe_id/);
    }
  });

  it('labels money explicitly: integer cents become dollars', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_payments_summary');
    expect(r.json.serviceAreaName).toBe('Charlotte, NC');
    expect((r.json.baseRatesUsd as Record<string, number>).babysitting1Kid).toBe(20);
    expect((r.json.baseRatesUsd as Record<string, number>).bookingFee).toBe(5);
    expect(r.json.paymentMethods).toEqual([{ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true }]);
    expect(r.json.promoCodes).toEqual([{ name: 'WELCOME', desc: 'Welcome credit', remainingUsd: 15, expiresOn: '2027-01-01' }]);
    const tx = r.json.transactions as Record<string, unknown>[];
    expect(tx[0]).toMatchObject({ type: 'Booking Payment', totalUsd: 85, tipUsd: 10, bookingId: 3003, sitter: 'Other Sitter' });
  });

  it('full keeps both cents and dollars', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_payments_summary', { view: 'full' });
    const tx = r.json.transactions as Record<string, unknown>[];
    expect(tx[0]).toMatchObject({ totalCents: 8500, totalUsd: 85, tipCents: 1000, tipUsd: 10 });
    expect((r.json.baseRates as Record<string, unknown>).babysitting1Kid).toEqual({ cents: 2000, usd: 20 });
  });

  it('caps the transaction list and reports the total', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_payments_summary', { transactions_limit: 2 });
    expect(r.json.transactionsTotal).toBe(3);
    expect(r.json.transactions).toHaveLength(2);
  });
});
