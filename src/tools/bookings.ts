import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { JuggleClient } from '../client.js';
import {
  JuggleId,
  UNTRUSTED_NOTES,
  flag,
  limitInput,
  list,
  num,
  offsetInput,
  pickScalars,
  rec,
  requireList,
  respond,
  str,
  viewInput,
  type Rec,
} from './shared.js';

/** Every booking status the site defines (live `bookingStatusColorsMap`). */
export const BOOKING_STATUSES = [
  'open',
  'booked',
  'in_progress',
  'awaiting_confirmation',
  'awaiting_completion',
  'awaiting_payment',
  'processing_payment',
  'awaiting_review',
  'failed_payment',
  'completed',
  'canceled',
  'declined',
  'expired',
  'archived',
] as const;

/** Finished one way or another. Everything else is still in play. */
const PAST = new Set(['completed', 'canceled', 'declined', 'expired', 'archived']);

export const SERVICES = ['babysitting', 'petsitting', 'homeschool_help'] as const;

function compactBookingItem(item: unknown, statusLabels: Rec, serviceLabels: Rec): Rec {
  const b = rec(item);
  const service = str(b.serviceType) ?? str(b.type);
  const seriesId = num(b.reoccurringBookingId);
  return {
    bookingId: num(b.id),
    status: str(b.status),
    statusLabel: str(statusLabels[String(b.status)]),
    service: (service && str(serviceLabels[service])) ?? service,
    start: str(b.startDateTimeFormatted),
    startDateTime: str(b.startDateTime),
    sitter: str(b.name) ?? null,
    pendingApplications: num(b.numPendingApplications),
    ...(seriesId !== undefined
      ? { recurring: { seriesId, days: b.reoccurringDotws ?? null, until: b.reoccurringUntilDate ?? null } }
      : {}),
  };
}

function compactBooking(data: unknown): unknown {
  const d = rec(data);
  const person = (x: unknown) => {
    const r = rec(x);
    return { accountId: num(r.accountId), profileId: num(r.profileId), ...(num(r.userId) !== undefined ? { userId: num(r.userId) } : {}), name: str(r.name) };
  };
  return {
    bookingId: num(d.bookingId),
    status: str(d.status),
    displayStatus: str(d.displayStatus),
    serviceType: str(d.serviceType),
    typeOfJob: str(d.typeOfJob),
    start: { date: str(d.startDate), time: str(d.startTime) },
    end: { date: str(d.endDate), time: str(d.endTime) },
    flexibleEnd: str(d.flexibleEndDatetime),
    isReoccurring: flag(d.isReoccurring),
    numKids: num(d.numKids),
    kidInfo: str(d.kidInfo),
    numPets: num(d.numPets),
    petInfo: str(d.petInfo),
    specialInstructions: str(d.specialInstructions),
    address: str(d.primaryAddrStr) ?? str(d.familyAddrStr),
    numSitters: num(d.numSitters),
    numBookedSitters: num(d.numBookedSitters),
    applicants: list(d.bookingRequests).map((x) => {
      const r = rec(x);
      return {
        ...person(r),
        rating: num(r.rating),
        numJobsCompleted: num(r.numJobsCompleted),
        status: str(r.bookingRequestStatus),
        requestedByYou: flag(r.requestSentFromFamily),
        isFavorite: flag(r.isFavorited ?? r.isFavorite),
        hoursUntilExpires: num(r.hoursUntilBookingRequestExpires),
      };
    }),
    bookedSitters: list(d.bookingSitters).map((x) => {
      const r = rec(x);
      return {
        ...person(r),
        rating: num(r.rating),
        numJobsCompleted: num(r.numJobsCompleted),
        phone: str(r.sitterPhoneNum),
        isFavorite: flag(r.isFavorited ?? r.isFavorite),
        canceled: flag(r.sitterCanceled),
        actualStart: str(r.sitterActualStartDateTime),
        actualEnd: str(r.sitterActualEndDateTime),
        cancellationReason: str(r.otherCancellationReason) ?? str(r.cancellationReason),
      };
    }),
    payment: { total: str(d.familyPaymentAmount), breakdown: pickScalarsDefined(d.familyPaymentBreakdown) },
    can: { cancel: flag(d.canCancelBooking), edit: flag(d.canEdit), sendMessage: flag(d.canSendMsg) },
    reviewedSitterAccountIds: list(d.sitterIdsWithBookingReviews),
  };
}

/** The non-null scalar entries of an object (the payment breakdown's display strings). */
function pickScalarsDefined(o: unknown): Rec {
  const all = pickScalars(o, Object.keys(rec(o)));
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null && v !== ''));
}

/** The bundle's Stripe plan rows — nothing a caller acts on in a booking. */
function withoutPlans(data: unknown): unknown {
  const { subscriptionPlan: _m, subscriptionYearlyPlan: _y, ...rest } = rec(data);
  return rest;
}

export function registerBookingTools(server: McpServer, client: JuggleClient): void {
  server.registerTool(
    'juggle_list_bookings',
    {
      title: 'List your Juggle bookings (sits/jobs)',
      description:
        'List your Juggle babysitting / petsitting bookings (the sits or jobs you posted): status (open, booked, in progress, awaiting payment/review, completed, canceled…), service, start date/time, the booked sitter, and how many sitter applications are waiting. status "active" (default) = still in play, "past" = completed/canceled/declined/expired/archived, "all"; or pass exact statuses. Sorted by start time. Use juggle_get_booking for applicants and details.',
      annotations: toolAnnotations({ title: 'List your Juggle bookings', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        status: z.enum(['active', 'past', 'all']).optional().describe('Which bookings: "active" (default), "past" or "all". Ignored when statuses is given.'),
        statuses: z.array(z.enum(BOOKING_STATUSES)).min(1).optional().describe('Exact booking statuses to include (overrides status).'),
        service: z.enum(SERVICES).optional().describe('Only this service.'),
        order: z.enum(['asc', 'desc']).optional().describe('By start time: "asc" soonest/oldest first (default) or "desc".'),
        limit: limitInput(50, 200, 'bookings'),
        offset: offsetInput('bookings'),
        view: viewInput(
          'compact: id, status (+label), service, start, sitter name, pending applications, recurring series. "full" returns the matching upstream booking items plus the status/service label maps; "raw" the whole page data with the list filtered.',
        ),
      }),
    },
    async ({ status, statuses, service, order, limit, offset, view }) => {
      const page = await client.getPage('/bookings');
      const data = rec(page.data);
      const all = requireList(data, 'bookings', '/bookings');
      const which = status ?? 'active';
      const wanted = statuses ? new Set<string>(statuses) : undefined;
      const matched = all
        .filter((x) => {
          const b = rec(x);
          const st = String(b.status);
          if (wanted) {
            if (!wanted.has(st)) return false;
          } else if (which === 'active' && PAST.has(st)) {
            return false;
          } else if (which === 'past' && !PAST.has(st)) {
            return false;
          }
          return !service || (b.serviceType ?? b.type) === service;
        })
        .sort((a, b) => {
          const x = String(rec(a).startDateTime ?? '');
          const y = String(rec(b).startDateTime ?? '');
          return order === 'desc' ? y.localeCompare(x) : x.localeCompare(y);
        });
      const start = offset ?? 0;
      const slice = matched.slice(start, start + (limit ?? 50));
      const head = {
        filter: statuses ? { statuses, service } : { status: which, service },
        total: all.length,
        matched: matched.length,
        offset: start,
        returned: slice.length,
      };
      const labels = { statuses: rec(data.bookingStatusesMap), services: rec(data.serviceTypesMap) };
      const full = { ...head, bookings: slice, bookingStatusesMap: data.bookingStatusesMap, serviceTypesMap: data.serviceTypesMap };
      if (view === 'raw') return respond(view, { ...head, ...data, bookings: slice }, { context: 'GET /bookings' });
      return respond(view, full, {
        context: 'GET /bookings',
        project: () => ({ ...head, bookings: slice.map((b) => compactBookingItem(b, labels.statuses, labels.services)) }),
      });
    },
  );

  server.registerTool(
    'juggle_get_booking',
    {
      title: 'Get a Juggle booking with its applicants',
      description:
        "Get one Juggle booking (sit/job) in detail: status, service, dates and times, kids/pets and notes, address, the sitters who APPLIED (applicants — accountId, name, rating, jobs completed, favorite, hours until the application expires) and the sitters BOOKED (with their phone number for the sit), the family payment total and breakdown, and whether you can cancel / edit / message. booking_id comes from juggle_list_bookings. Applicant accountIds are what accepting or declining a sitter needs; profileId opens juggle_get_sitter; userId is the sitter's messaging id." +
        ' ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a Juggle booking', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        booking_id: JuggleId.describe('The booking id (bookingId from juggle_list_bookings).'),
        view: viewInput(
          'compact: the fields above with applicants/booked sitters projected. "full" is the upstream booking page data minus the subscription-plan rows; "raw" the same, indented.',
        ),
      }),
    },
    async ({ booking_id, view }) => {
      const page = await client.getPage(`/bookings/${booking_id}`);
      return respond(view, withoutPlans(page.data), {
        context: `GET /bookings/${booking_id}`,
        project: compactBooking,
        untrustedNote: UNTRUSTED_NOTES.booking,
      });
    },
  );
}
