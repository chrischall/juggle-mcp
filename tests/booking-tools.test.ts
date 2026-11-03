import { describe, expect, it } from 'vitest';
import { bookingDetailData, bookingsData } from './fixtures.js';
import { callTool, makeClient, siteWith } from './tool-harness.js';

type Rec = Record<string, unknown>;

describe('juggle_list_bookings', () => {
  const site = () => siteWith({ '/bookings': ['Bookings', bookingsData] });

  it('defaults to ACTIVE bookings, soonest first, projected compactly', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings');
    expect(r.json).toMatchObject({ filter: { status: 'active' }, total: 4, matched: 2, returned: 2 });
    const b = r.json.bookings as Rec[];
    expect(b.map((x) => x.bookingId)).toEqual([3002, 3001]);
    expect(b[0]).toEqual({
      bookingId: 3002,
      status: 'booked',
      statusLabel: 'Booked',
      service: 'Babysitting',
      start: 'Tue, Nov 10 at 5:00pm',
      startDateTime: '2026-11-10 17:00:00',
      sitter: 'Test Sitter',
      pendingApplications: 0,
      recurring: { seriesId: 77, days: 'Tue', until: '2026-12-31' },
    });
    expect(b[1]).toMatchObject({ bookingId: 3001, sitter: null, pendingApplications: 2 });
    expect(b[1].recurring).toBeUndefined();
    expect(r.text).not.toContain('imgUrl');
  });

  it('past = completed/canceled/declined/expired/archived', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings', { status: 'past', order: 'desc' });
    expect((r.json.bookings as Rec[]).map((x) => x.bookingId)).toEqual([3003, 3004]);
  });

  it('filters by exact statuses and service, and pages', async () => {
    const c = makeClient(site());
    const a = await callTool(c, 'juggle_list_bookings', { statuses: ['completed', 'canceled'], service: 'petsitting' });
    expect((a.json.bookings as Rec[]).map((x) => x.bookingId)).toEqual([3003]);
    const p = await callTool(c, 'juggle_list_bookings', { status: 'all', limit: 1, offset: 1 });
    expect(p.json).toMatchObject({ matched: 4, returned: 1, offset: 1 });
    expect((p.json.bookings as Rec[])[0].bookingId).toBe(3003);
  });

  it('full returns the filtered upstream items unprojected (minus the option lists)', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_bookings', { view: 'full' });
    const b = r.json.bookings as Rec[];
    expect(b[0]).toMatchObject({ id: 3002, url: '/bookings/3002', reoccurringBookingId: 77 });
  });

  it('a page that lost its bookings array is a typed error, not an empty list', async () => {
    const r = await callTool(makeClient(siteWith({ '/bookings': ['Bookings', { items: [] }] })), 'juggle_list_bookings');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/bookings/);
  });
});

describe('juggle_get_booking', () => {
  const site = () => siteWith({ '/bookings/3001': ['BookingDetails', bookingDetailData] });

  it('projects the booking, applicants and booked sitters, framed as untrusted', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_booking', { booking_id: 3001 });
    expect(r.isError).toBe(false);
    expect(r.json.untrusted_content).toBe(true);
    expect(r.json).toMatchObject({
      bookingId: 3001,
      status: 'open',
      displayStatus: 'Open',
      serviceType: 'babysitting',
      start: { date: '2026-11-20', time: '6:00pm' },
      end: { date: '2026-11-20', time: '10:00pm' },
      numKids: 2,
      address: '1 Test St, Testville, NC 28200',
      specialInstructions: 'Please arrive 10 minutes early.',
      payment: { total: '$85.00' },
      can: { cancel: true, edit: true, sendMessage: true },
      reviewedSitterAccountIds: [1199],
    });
    expect(r.json.applicants).toEqual([
      { accountId: 1101, profileId: 1201, name: 'Test Sitter', rating: 4.9, numJobsCompleted: 30, status: 'pending', requestedByYou: false, isFavorite: true, hoursUntilExpires: 45 },
      { accountId: 1102, profileId: 1202, name: 'Second Sitter', rating: 4.5, numJobsCompleted: 4, status: 'pending', requestedByYou: true, isFavorite: false, hoursUntilExpires: 47 },
    ]);
    expect(r.json.bookedSitters).toEqual([
      { accountId: 1103, profileId: 1203, userId: 1303, name: 'Booked Sitter', rating: 5, numJobsCompleted: 12, phone: '555-0199', isFavorite: false, canceled: false },
    ]);
    expect(r.text).not.toContain('stripe_id');
  });

  it('rejects a non-numeric id before any request', async () => {
    const s = site();
    const r = await callTool(makeClient(s), 'juggle_get_booking', { booking_id: '3001/../x' });
    expect(r.isError).toBe(true);
    expect(s.requests).toHaveLength(0);
  });

  it('maps a 404 to an actionable error', async () => {
    const r = await callTool(makeClient(site()), 'juggle_get_booking', { booking_id: 9999 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/404/);
  });
});
