// The confirm-gated writes (owner scope): post a sit, accept / decline an
// applicant, cancel a booking, send a message, favorite / unfavorite a sitter,
// leave a review. Every request shape is lifted from the site's own JS bundle
// (call sites cited per tool). Favorite/unfavorite, post job and cancel are verified live (2026-11-03); the rest are UNVERIFIED against a signed-in account
// until the live pass — see docs/JUGGLE-API.md §4.
//
// Money: nothing here moves money. post_job always sends the bonus / autopay /
// tip / promo fields switched off, and cancel never sends the
// `cancellationFee` penalty (that path charges a card through Stripe).

import type { McpServer } from '@modelcontextprotocol/server';
import { IsoDate, IsoTime, McpToolError, defineWrite, registerWrite } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { JuggleClient } from '../client.js';
import { SERVICES } from './bookings.js';
import { readFavorites } from './sitters.js';
import { JuggleId, flag, list, num, rec, requireList, str, usd, type Rec } from './shared.js';
import { sendOnce, writeAnnotations, writeDescription, writeResult } from './write-kit.js';

const checkBooking = (id: number) => `the booking on whyjuggle.com (juggle_get_booking booking_id=${id})`;

/** `YYYY-MM-DD` + `days`, on the calendar (no timezone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Hours between two local `date time` pairs (both `YYYY-MM-DD`, `HH:MM`). */
function hoursBetween(startDate: string, startTime: string, endDate: string, endTime: string): number {
  const ms = Date.parse(`${endDate}T${endTime}:00Z`) - Date.parse(`${startDate}T${startTime}:00Z`);
  return ms / 3_600_000;
}

/** Kid-priced services: babysitting and homeschool help share the kids rates and sitter count (chunk 8383). */
const isKidService = (service: string) => service === 'babysitting' || service === 'homeschool_help';

/**
 * The site's hourly base rate (cents) per sitter for this service and head
 * count; `undefined` when not derivable. Mirrors chunk 8383 `hourlyRate`:
 * more than 4 kids switches to the per-sitter `multisitter` rate.
 */
function baseRateCents(rates: Rec, service: string, numKids: number | null, numPets: number | null): number | undefined {
  if (isKidService(service) && numKids) {
    if (numKids > 4) return num(rates.multisitter);
    return num(rates[`babysitting${numKids}${numKids === 1 ? 'Kid' : 'Kids'}`]);
  }
  if (service === 'petsitting' && numPets) {
    const key = numPets >= 4 ? 'petsitting4OrMorePets' : `petsitting${numPets}${numPets === 1 ? 'Pet' : 'Pets'}`;
    return num(rates[key]);
  }
  return undefined;
}

/** The booking page plus one applicant, for accept / decline. */
async function readApplicant(client: JuggleClient, bookingId: number, sitterAccountId: number) {
  const page = await client.getPage(`/bookings/${bookingId}`);
  const d = rec(page.data);
  const requests = list(d.bookingRequests).map(rec);
  const request = requests.find((r) => num(r.accountId) === sitterAccountId);
  if (!request) {
    const ids = requests.map((r) => `${num(r.accountId)} (${str(r.name) ?? 'unnamed'}, ${str(r.bookingRequestStatus) ?? '?'})`);
    throw new McpToolError(`Sitter account ${sitterAccountId} has no application on booking ${bookingId}.`, {
      hint: ids.length
        ? `Applicants on this booking (accountId): ${ids.join(', ')}. See juggle_get_booking.`
        : 'This booking has no applicants yet. See juggle_get_booking.',
    });
  }
  return { d, request };
}

export function registerWriteTools(server: McpServer, client: JuggleClient): void {
  // -------------------------------------------------------------- post a job
  registerWrite(
    server,
    defineWrite({
      name: 'juggle_post_job',
      description: writeDescription(
        'Post a new babysitting / petsitting / homeschool-help job (a "sit") on Juggle for sitters to apply to — or invite one sitter directly with sitter_account_id. One-time jobs only (no recurring series). Uses your primary address unless address_id is given (ids from juggle_get_profile); kid / pet counts default to your profile. An end time at or before 05:00 means the next morning, as on the website. Never adds bonuses, tips, autopay or promo codes. Sitters are notified once it is posted; juggle_cancel_booking cancels it.',
      ),
      annotations: writeAnnotations('Post a Juggle job (sit)', true),
      inputSchema: z.object({
        service: z.enum(SERVICES).describe('babysitting, petsitting or homeschool_help.'),
        start_date: IsoDate.describe('Start date, YYYY-MM-DD.'),
        start_time: IsoTime.describe('Start time, HH:MM (24h, local).'),
        end_time: IsoTime.describe('End time, HH:MM (24h, local). At or before 05:00 = the next day unless end_date says otherwise.'),
        end_date: IsoDate.optional().describe('End date, YYYY-MM-DD (default: start_date, or the next day for an end at or before 05:00).'),
        address_id: JuggleId.optional().describe('Which of your addresses (id from juggle_get_profile). Default: your primary address.'),
        num_kids: z.number().int().min(0).max(20).optional().describe('Number of kids (default: from your profile). Required ≥1 for babysitting / homeschool help.'),
        num_pets: z.number().int().min(0).max(20).optional().describe('Number of pets (default: from your profile). Required ≥1 for petsitting.'),
        special_instructions: z.string().trim().min(1).max(5000).optional().describe('Notes for the sitter (bedtimes, allergies, where to park…). Sitters who apply can read this.'),
        post_on_open_jobs: z.boolean().optional().describe('Also list it on the public Open Jobs board for all sitters (default true, as on the website).'),
        sitter_account_id: JuggleId.optional().describe('Invite this sitter (accountId from juggle_list_sitters / juggle_list_favorites) to the job.'),
      }),
      async plan(args) {
        const route = args.sitter_account_id ? `/bookings/create/${args.sitter_account_id}` : '/bookings/create';
        const form = rec((await client.getPage(route)).data);
        const lists = rec(form.lists);
        const addrs = list(lists.addrs).map(rec);
        const addr = args.address_id ?? num(form.addr);
        const address = addrs.find((a) => num(a.id) === addr);
        if (addr === undefined || !address) {
          throw new McpToolError(
            args.address_id ? `Address ${args.address_id} is not one of your Juggle addresses.` : 'Juggle has no default address for your account.',
            { hint: `Your addresses (address_id): ${addrs.map((a) => `${num(a.id)} (${str(a.name) ?? '?'})`).join(', ') || 'none — add one on whyjuggle.com'}.` },
          );
        }
        const numKids = args.num_kids ?? num(form.numKids) ?? null;
        const numPets = args.num_pets ?? num(form.numPets) ?? null;
        if (args.service === 'petsitting' ? !numPets : !numKids) {
          throw new McpToolError(`A ${args.service} job needs at least one ${args.service === 'petsitting' ? 'pet' : 'kid'}.`, {
            hint: `Pass ${args.service === 'petsitting' ? 'num_pets' : 'num_kids'} ≥ 1.`,
          });
        }
        const endDate = args.end_date ?? (args.end_time <= '05:00' ? addDays(args.start_date, 1) : args.start_date);
        const hours = hoursBetween(args.start_date, args.start_time, endDate, args.end_time);
        if (!(hours > 0)) {
          throw new McpToolError(`The job must end after it starts (${args.start_date} ${args.start_time} → ${endDate} ${args.end_time}).`);
        }
        const serviceAreaId = num(form.serviceAreaId) ?? null;
        const sitterAccountId = num(form.sitterAccountId) ?? args.sitter_account_id ?? null;
        let sitterIsAvailable: boolean | null = null;
        if (sitterAccountId !== null) {
          // The form's own availability check (a read) — informational, as on the site.
          const check = rec(
            await client.getJson('/bookings/create/check-sitter-availability', {
              sitterAccountId,
              startDate: args.start_date,
              startTime: args.start_time,
              endDate,
              endTime: args.end_time,
            }),
          );
          sitterIsAvailable = flag(check.sitterIsAvailable) ?? null;
        }
        // Exactly the bundle's POST /bookings body for a family create
        // (chunk 8383 addEditJob), money fields off.
        const body = {
          markBookingAsAddedEditedBySetUser: 1,
          serviceAreaId,
          service: args.service,
          status: null,
          startDate: args.start_date,
          startTime: args.start_time,
          willSpanMultipleDays: endDate !== args.start_date ? 1 : 0,
          endDate,
          endTime: args.end_time,
          flexibleEndTime: null,
          numUnpaidHours: null,
          isReoccurringBooking: 0,
          reoccurringBookingDaysOfTheWeek: [],
          reoccurringUntilDate: null,
          reoccurringBookingOneSitterOnly: null,
          sendRequestToSitterForEntireReoccurringSeries: true,
          numKids,
          numPets,
          addr,
          specialInstructions: args.special_instructions ?? null,
          emergencyBonusAmt: null,
          juggleEmergencyBonusAmt: null,
          postOnOpenJobs: args.post_on_open_jobs ?? true,
          postAsBackup: true,
          includeTransporationCosts: false,
          enableAutopay: false,
          autopayTipPercent: [],
          autopayTipAmt: null,
          autopayPromoCodesGiftCards: [],
          sitterAccountId,
          sitterIsAvailable,
          userId: null,
          id: null,
        };
        // Flat cents/hour map (live 2026-11-03; not keyed by service area).
        const rate = baseRateCents(rec(form.baseRates), args.service, numKids, numPets);
        // chunk 8383 `numSitters`: one sitter per 4 kids for kid services, one for pets.
        const sitters = isKidService(args.service) && numKids ? Math.ceil(numKids / 4) : 1;
        const sitterName = str(form.sitterUserFullName);
        return {
          gate: {
            action: 'juggle.post_job',
            summary: `Post a ${args.service} job on Juggle, ${args.start_date} ${args.start_time} → ${endDate} ${args.end_time}${sitterName ? `, inviting ${sitterName}` : ''}`,
            account: client.account,
            request: { method: 'POST', path: '/bookings', body },
            preview: {
              address: str(address.name),
              hours,
              ...(sitterAccountId !== null ? { invitedSitter: sitterName ?? `account ${sitterAccountId}`, sitterIsAvailable } : {}),
              ...(rate !== undefined
                ? {
                    estimate: {
                      baseRatePerHourUsd: usd(rate),
                      sitters,
                      totalUsd: usd(rate * hours * sitters),
                      note: 'Base rate only — before surge pricing, the booking fee and any tip. Payment happens after the sit, on the website.',
                    },
                  }
                : {}),
            },
          },
          state: { body, service: args.service, start: `${args.start_date} ${args.start_time}` },
        };
      },
      async execute({ body, service, start }) {
        return sendOnce(
          async () => {
            await client.send('POST', '/bookings', body);
            // The site returns no id; find the new booking the way its UI would.
            let bookingId: number | undefined;
            try {
              const bookings = requireList((await client.getPage('/bookings')).data, 'bookings', '/bookings').map(rec);
              const match = bookings
                .filter((b) => String(b.startDateTime ?? '').startsWith(start) && (b.serviceType ?? b.type) === service)
                .map((b) => num(b.id))
                .filter((id): id is number => id !== undefined);
              if (match.length) bookingId = Math.max(...match);
            } catch {
              // Posted; only the follow-up lookup failed.
            }
            return {
              posted: true,
              ...(bookingId !== undefined ? { bookingId } : { note: 'Posted, but the new booking could not be identified — see juggle_list_bookings.' }),
              service,
              start,
            };
          },
          'job post',
          'juggle_list_bookings',
        );
      },
      render: writeResult,
    }),
  );

  // ---------------------------------------------------- accept / decline
  for (const verb of ['accept', 'decline'] as const) {
    const name = `juggle_${verb}_sitter`;
    registerWrite(
      server,
      defineWrite({
        name,
        description: writeDescription(
          verb === 'accept'
            ? "Accept (book) a sitter who applied to one of your Juggle jobs. The sitter is notified and booked; you pay for the sit afterwards on the website. booking_id from juggle_list_bookings; sitter_account_id is the applicant's accountId from juggle_get_booking. for_all_in_series books them for every open job left in a recurring series. There is no un-book tool here."
            : "Decline a sitter's application to one of your Juggle jobs. The sitter is notified; there is no undo. booking_id from juggle_list_bookings; sitter_account_id is the applicant's accountId from juggle_get_booking. for_all_in_series declines them for every open job left in a recurring series.",
        ),
        annotations: writeAnnotations(verb === 'accept' ? 'Accept a Juggle sitter' : 'Decline a Juggle sitter', true),
        inputSchema: z.object({
          booking_id: JuggleId.describe('The booking id (bookingId from juggle_list_bookings).'),
          sitter_account_id: JuggleId.describe("The applicant's accountId (from juggle_get_booking's applicants)."),
          for_all_in_series: z.boolean().optional().describe('Recurring bookings only: apply to every open job left in the series (default false).'),
        }),
        async plan({ booking_id, sitter_account_id, for_all_in_series }) {
          const { d, request } = await readApplicant(client, booking_id, sitter_account_id);
          const status = str(request.bookingRequestStatus);
          if (status !== 'pending') {
            throw new McpToolError(`That application is "${status ?? 'unknown'}", not pending — nothing to ${verb}.`, {
              hint: 'See juggle_get_booking for the current applicants.',
            });
          }
          if (for_all_in_series && flag(d.isReoccurring) !== true) {
            throw new McpToolError(`Booking ${booking_id} is not part of a recurring series, so for_all_in_series does not apply.`);
          }
          // The UI sends `{forAll: true}` for "… for All Jobs" and `{}` otherwise (chunk 6891).
          const body = for_all_in_series ? { forAll: true } : {};
          const path = `/bookings/${booking_id}/${verb}-sitter/${sitter_account_id}`;
          const sitter = str(request.name) ?? `account ${sitter_account_id}`;
          return {
            gate: {
              action: `juggle.${verb}_sitter`,
              summary: `${verb === 'accept' ? 'Accept (book)' : 'Decline'} ${sitter} for booking ${booking_id}${for_all_in_series ? ' and every open job left in its series' : ''}`,
              account: client.account,
              target: `${booking_id}/${sitter_account_id}`,
              revision: `${str(d.status)}|${status}|${num(d.numBookedSitters) ?? 0}`,
              request: { method: 'PATCH', path, body },
              preview: {
                sitter,
                rating: num(request.rating),
                jobsCompleted: num(request.numJobsCompleted),
                booking: {
                  service: str(d.serviceType),
                  start: `${str(d.startDate) ?? '?'} ${str(d.startTime) ?? ''}`.trim(),
                  end: `${str(d.endDate) ?? '?'} ${str(d.endTime) ?? ''}`.trim(),
                  status: str(d.displayStatus) ?? str(d.status),
                  ...(verb === 'accept' ? { familyPaymentAmount: str(d.familyPaymentAmount) } : {}),
                },
              },
            },
            state: { path, body, booking_id, sitter },
          };
        },
        async execute({ path, body, booking_id, sitter }) {
          return sendOnce(
            async () => {
              const res = rec((await client.send('PATCH', path, body)).data);
              return {
                [verb === 'accept' ? 'accepted' : 'declined']: true,
                bookingId: booking_id,
                sitter,
                ...(str(res.status) ? { status: str(res.status), displayStatus: str(res.displayStatus) } : {}),
                ...(num(res.numBookedSitters) !== undefined ? { numBookedSitters: num(res.numBookedSitters) } : {}),
              };
            },
            `${verb} of ${sitter}`,
            checkBooking(booking_id),
          );
        },
        render: writeResult,
      }),
    );
  }

  // ------------------------------------------------------------- cancel
  registerWrite(
    server,
    defineWrite({
      name: 'juggle_cancel_booking',
      description: writeDescription(
        "Cancel one of your Juggle bookings (sits/jobs). Any booked sitter and applicants are notified; there is no undo. reason is a cancellation-reason id or its label (the tool lists the valid ones if it does not match); details is optional free text. Within 12 hours of the start (or after it started) Juggle requires a penalty: this tool only ever takes the ONE-STAR REVIEW penalty, and only when accept_one_star_review is true — it never pays the cancellation fee (finish on whyjuggle.com for that).",
      ),
      annotations: writeAnnotations('Cancel a Juggle booking', true),
      inputSchema: z.object({
        booking_id: JuggleId.describe('The booking id (bookingId from juggle_list_bookings).'),
        reason: z.string().trim().min(1).max(200).describe('Cancellation reason: its id or its label (e.g. "Plans changed").'),
        details: z.string().trim().min(1).max(2000).optional().describe('Additional information about why you are canceling (shared with Juggle / the sitter).'),
        accept_one_star_review: z
          .boolean()
          .optional()
          .describe('Set true ONLY after the user agrees to take a one-star review as the late-cancellation penalty (needed within 12 hours of the start).'),
      }),
      async plan({ booking_id, reason, details, accept_one_star_review }) {
        const booking = rec((await client.getPage(`/bookings/${booking_id}`)).data);
        if (flag(booking.canCancelBooking) === false) {
          throw new McpToolError(`Juggle does not allow canceling booking ${booking_id} (status: ${str(booking.displayStatus) ?? str(booking.status) ?? 'unknown'}).`, {
            hint: 'See juggle_get_booking; a finished or already-canceled booking cannot be canceled.',
          });
        }
        const form = rec((await client.getPage(`/bookings/${booking_id}/cancel`)).data);
        const reasons = list(rec(form.lists).bookingCancellationReasons).map(rec);
        const wanted = reason.toLowerCase();
        const match = reasons.find((r) => String(r.id) === reason) ?? reasons.find((r) => str(r.name)?.toLowerCase() === wanted);
        if (!match) {
          throw new McpToolError(`"${reason}" is not one of Juggle's cancellation reasons.`, {
            hint: `Valid reasons (id — label): ${reasons.map((r) => `${String(r.id)} — ${str(r.name) ?? ''}`).join('; ') || 'none listed'}.`,
          });
        }
        const requirePenalty = flag(form.requireCancellationPenalty) === true;
        const penaltyNeeded = requirePenalty || flag(form.cancelingTooCloseToBookingStart) === true;
        const fee = usd(form.cancellationFee);
        if (penaltyNeeded && accept_one_star_review !== true) {
          throw new McpToolError(
            `Booking ${booking_id} is within 12 hours of its start (or has started), so Juggle requires a penalty to cancel: a one-star review on your account, or a cancellation fee${fee !== undefined ? ` of $${fee.toFixed(2)}` : ''}.`,
            {
              hint: 'This tool never pays the fee. If the user agrees to the one-star review, re-call with accept_one_star_review=true; to pay the fee instead, cancel on whyjuggle.com.',
            },
          );
        }
        // Exactly the bundle's PATCH body (chunk 1256 cancelBooking); never "cancellationFee".
        const body = {
          requireCancellationPenalty: flag(form.requireCancellationPenalty) ?? false,
          cancellationReason: match.id,
          otherCancellationReason: details ?? null,
          cancellationPenalty: penaltyNeeded ? 'oneStarReview' : null,
        };
        const path = `/bookings/${booking_id}/cancel`;
        const booked = list(booking.bookingSitters).map((s) => str(rec(s).name)).filter((n): n is string => !!n);
        return {
          gate: {
            action: 'juggle.cancel_booking',
            summary: `Cancel Juggle booking ${booking_id} (${str(booking.serviceType) ?? 'job'}, ${str(booking.startDate) ?? '?'} ${str(booking.startTime) ?? ''})`.replace(' )', ')'),
            account: client.account,
            target: booking_id,
            revision: `${str(booking.status)}|${booked.length}`,
            request: { method: 'PATCH', path, body },
            preview: {
              reason: str(match.name) ?? String(match.id),
              status: str(booking.displayStatus) ?? str(booking.status),
              bookedSitters: booked,
              pendingApplicants: list(booking.bookingRequests).filter((r) => rec(r).bookingRequestStatus === 'pending').length,
              ...(penaltyNeeded ? { penalty: 'A one-star review on your account (late cancellation).' } : {}),
            },
          },
          state: { path, body, booking_id },
        };
      },
      async execute({ path, body, booking_id }) {
        return sendOnce(
          async () => {
            const res = rec((await client.send('PATCH', path, body)).data);
            if (flag(res.confirmationRequired) === true) {
              // The site wants a card payment confirmed in the browser — out of scope.
              return {
                canceled: false,
                bookingId: booking_id,
                warning: 'Juggle asked for a cancellation-fee payment before canceling. Nothing was paid and the booking was NOT canceled; finish on whyjuggle.com if the user wants to pay the fee.',
              };
            }
            return { canceled: true, bookingId: booking_id };
          },
          'cancellation',
          checkBooking(booking_id),
        );
      },
      render: writeResult,
    }),
  );

  // ------------------------------------------------------------ message
  registerWrite(
    server,
    defineWrite({
      name: 'juggle_send_message',
      description: writeDescription(
        'Send a text message in one of your Juggle conversations (chat with a sitter). conversation_id comes from juggle_list_conversations. The sitter receives it and it cannot be unsent. Text only (no images).',
      ),
      annotations: writeAnnotations('Send a Juggle message', true),
      inputSchema: z.object({
        conversation_id: JuggleId.describe('The conversation id (conversationId from juggle_list_conversations).'),
        text: z.string().trim().min(1).max(5000).describe('The message text (plain text; line breaks are kept).'),
      }),
      async plan({ conversation_id, text }) {
        // The inbox, not the thread: opening the thread may mark it read.
        const conversations = requireList((await client.getPage('/messages')).data, 'conversations', '/messages').map(rec);
        const convo = conversations.find((c) => num(c.id) === conversation_id);
        if (!convo) {
          throw new McpToolError(`Conversation ${conversation_id} is not in your Juggle inbox.`, {
            hint: 'Get conversation ids from juggle_list_conversations.',
          });
        }
        const to = str(convo.name) ?? `conversation ${conversation_id}`;
        const body = { conversationId: conversation_id, type: 'text', content: text };
        return {
          gate: {
            action: 'juggle.send_message',
            summary: `Send a Juggle message to ${to}`,
            account: client.account,
            target: conversation_id,
            request: { method: 'POST', path: '/messages', body },
            preview: { to },
          },
          state: { body, to },
        };
      },
      async execute({ body, to }) {
        return sendOnce(
          async () => {
            const res = rec((await client.send('POST', '/messages', body)).data);
            // The response is the refreshed thread; find ours, return nothing else from it.
            const mine = list(res.messages)
              .map(rec)
              .filter((m) => flag(m.myMessage) === true && m.content === body.content);
            const last = mine[mine.length - 1];
            return {
              sent: true,
              conversationId: body.conversationId,
              to,
              ...(last ? { messageId: num(last.id), sentAt: str(last.sentAt) } : { note: 'Sent; the reply did not echo it back — check juggle_get_conversation.' }),
            };
          },
          `message to ${to}`,
          `the conversation (juggle_get_conversation conversation_id=${body.conversationId})`,
        );
      },
      render: writeResult,
    }),
  );

  // -------------------------------------------------- favorite / unfavorite
  for (const add of [true, false]) {
    const name = add ? 'juggle_favorite_sitter' : 'juggle_unfavorite_sitter';
    registerWrite(
      server,
      defineWrite({
        name,
        description: writeDescription(
          add
            ? 'Add a sitter to your Juggle favorites (sitter_account_id = accountId from juggle_list_sitters or a booking\'s applicants). Private to you; juggle_unfavorite_sitter undoes it.'
            : 'Remove a sitter from your Juggle favorites (sitter_account_id = accountId from juggle_list_favorites). Private to you; juggle_favorite_sitter undoes it.',
        ),
        // An inverse pair, private to the family: not destructive.
        annotations: writeAnnotations(add ? 'Favorite a Juggle sitter' : 'Unfavorite a Juggle sitter', false),
        inputSchema: z.object({
          sitter_account_id: JuggleId.describe("The sitter's accountId."),
        }),
        async plan({ sitter_account_id }) {
          const { favorites } = await readFavorites(client);
          const current = favorites.find((s) => num(s.accountId) === sitter_account_id);
          const sitter = str(current?.name) ?? `sitter account ${sitter_account_id}`;
          const path = `/favorites/${sitter_account_id}`;
          return {
            gate: {
              action: add ? 'juggle.favorite_sitter' : 'juggle.unfavorite_sitter',
              summary: `${add ? 'Add' : 'Remove'} ${sitter} ${add ? 'to' : 'from'} your Juggle favorites`,
              account: client.account,
              target: sitter_account_id,
              revision: current ? 'favorite' : 'not_favorite',
              request: { method: add ? 'POST' : 'DELETE', path },
              preview: {
                sitter,
                currentlyFavorite: current !== undefined,
                ...(add === (current !== undefined) ? { note: `Already ${add ? 'a favorite' : 'not a favorite'}; sending it again changes nothing.` } : {}),
              },
            },
            state: { path, sitter_account_id },
          };
        },
        async execute({ path, sitter_account_id }) {
          return sendOnce(
            async () => {
              // The UI ignores the response body (chunk 7250 toggleFavorite).
              await client.send(add ? 'POST' : 'DELETE', path, undefined, { anyBody: true });
              return { sitterAccountId: sitter_account_id, favorite: add };
            },
            add ? 'favorite' : 'unfavorite',
            'juggle_list_favorites',
          );
        },
        render: writeResult,
      }),
    );
  }

  // ------------------------------------------------------------- review
  registerWrite(
    server,
    defineWrite({
      name: 'juggle_leave_review',
      description: writeDescription(
        'Leave a review of a sitter for a finished Juggle booking: a 0–5 star rating in half stars, plus optional comments. The sitter and other families can see it and there is no edit or delete tool. booking_id from juggle_list_bookings (status completed / awaiting review / awaiting payment); sitter_account_id is the booked sitter\'s accountId from juggle_get_booking.',
      ),
      annotations: writeAnnotations('Review a Juggle sitter', true),
      inputSchema: z.object({
        booking_id: JuggleId.describe('The finished booking (bookingId from juggle_list_bookings).'),
        sitter_account_id: JuggleId.describe("The booked sitter's accountId (from juggle_get_booking)."),
        rating: z.number().min(0).max(5).multipleOf(0.5).describe('Stars, 0–5 in steps of 0.5.'),
        comments: z.string().trim().min(1).max(5000).optional().describe('Review text (optional; public).'),
      }),
      async plan({ booking_id, sitter_account_id, rating, comments }) {
        const form = rec((await client.getPage(`/reviews/create/${booking_id}/${sitter_account_id}`)).data);
        const sitter = str(form.userName) ?? `sitter account ${sitter_account_id}`;
        if (flag(form.reviewAlreadyProvided) === true) {
          throw new McpToolError(`You already left a review for ${sitter} on booking ${booking_id}.`, {
            hint: 'Juggle allows one review per sitter per booking; see juggle_get_reviews.',
          });
        }
        // Exactly the bundle's body (chunk 30 leaveAReview); outsideApp is only
        // asked when reviewing a family, so a family reviewing a sitter sends the default 0.
        const body = { rating, comments: comments ?? null, outsideApp: 0 };
        const path = `/reviews/${booking_id}/${sitter_account_id}`;
        return {
          gate: {
            action: 'juggle.leave_review',
            summary: `Review ${sitter} (${rating} stars) for booking ${booking_id}`,
            account: client.account,
            target: `${booking_id}/${sitter_account_id}`,
            request: { method: 'POST', path, body },
            preview: { sitter },
          },
          state: { path, body, booking_id, sitter },
        };
      },
      async execute({ path, body, booking_id, sitter }) {
        return sendOnce(
          async () => {
            // The UI ignores the body and reloads the booking.
            await client.send('POST', path, body, { anyBody: true });
            return { reviewed: true, bookingId: booking_id, sitter, rating: body.rating };
          },
          `review of ${sitter}`,
          'juggle_get_reviews for the sitter',
        );
      },
      render: writeResult,
    }),
  );
}
