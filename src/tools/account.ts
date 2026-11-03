import type { McpServer } from '@modelcontextprotocol/server';
import { toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { JuggleClient } from '../client.js';
import type { JuggleUser } from '../page.js';
import { flag, limitInput, list, num, optionName, pickScalars, rec, respond, str, usd, viewInput, type Rec } from './shared.js';

// ------------------------------------------------------------------ profile

/**
 * The family profile, ALLOWLISTED. `/my-profile` also carries the family's
 * phone numbers, emergency contact, house instructions (door codes live
 * there), church/club notes and audit columns — none of them are copied.
 * Kids (names, birthdays, allergies) only when `includeKids`.
 */
export function sanitizeProfile(data: unknown, user: JuggleUser | null, includeKids: boolean): Rec {
  const d = rec(data);
  const p = rec(d.profile);
  const states = d.states;
  const kids = list(d.kids);
  return {
    accountId: user?.accountId,
    userId: num(user?.id),
    fullName: str(d.fullName),
    firstName: str(d.firstName),
    lastName: str(d.lastName),
    email: str(d.email),
    serviceAreaId: num(d.serviceAreaId),
    serviceArea: optionName(d.serviceAreas, d.serviceAreaId),
    isActive: flag(d.isActive),
    hasSubscription: flag(d.hasSubscription),
    referralCode: str(d.referralCode),
    unreadMessages: num(user?.numUnreadMsgs),
    partnerName: str(p.partner_name),
    neighborhood: str(p.neighborhood),
    school: str(p.school),
    stats: {
      jobsPosted: num(p.num_jobs_posted),
      jobsCompleted: num(p.num_jobs_completed),
      jobsCanceled: num(p.num_jobs_canceled),
      rating: num(p.rating),
    },
    addresses: list(d.addrs).map((a) => {
      const r = rec(a);
      return {
        id: num(r.id),
        streetAddr: str(r.streetAddr),
        city: str(r.city),
        state: optionName(states, r.state) ?? r.state,
        zipCode: str(r.zipCode),
        primary: flag(r.primary),
      };
    }),
    numKids: kids.length,
    ...(includeKids
      ? {
          kids: kids.map((k) => {
            const r = rec(k);
            return {
              ...pickScalars(r, ['id', 'name', 'birthday', 'grade', 'school', 'hobbies', 'foods', 'allergies', 'specialNeeds', 'dailyRoutines', 'otherInformation']),
              gender: optionName(d.genders, r.gender),
            };
          }),
        }
      : {}),
    pets: list(d.pets).map((x) => {
      const r = rec(x);
      return { ...pickScalars(r, ['id', 'name', 'breed', 'age']), type: optionName(d.petTypes, r.type) ?? r.type };
    }),
    friends: list(d.friends).map((f) => pickScalars(f, ['id', 'name', 'url', 'displayStatus'])),
  };
}

function compactProfile(safe: unknown): unknown {
  const s = rec(safe);
  return {
    accountId: s.accountId,
    fullName: s.fullName,
    email: s.email,
    serviceArea: s.serviceArea,
    isActive: s.isActive,
    hasSubscription: s.hasSubscription,
    unreadMessages: s.unreadMessages,
    stats: s.stats,
    addresses: list(s.addresses).map((a) => {
      const r = rec(a);
      const line = [r.streetAddr, r.city, [r.state, r.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return { id: r.id, address: line, primary: r.primary };
    }),
    numKids: s.numKids,
    ...(s.kids ? { kids: s.kids } : {}),
    pets: list(s.pets).map((x) => ({ name: rec(x).name, type: rec(x).type })),
    numFriends: list(s.friends).length,
  };
}

// ------------------------------------------------------------------ payments

/**
 * The payments page, ALLOWLISTED. `/payments` carries a live Stripe
 * SetupIntent (`intent.client_secret`), the publishable key and payment-method
 * ids — none are copied. Money is integer cents upstream; every amount is
 * returned as `…Cents` plus `…Usd`.
 */
export function sanitizePayments(data: unknown, transactionsLimit: number): Rec {
  const d = rec(data);
  const defaultId = d.defaultPaymentMethodId;
  const baseRates: Rec = {};
  for (const [k, v] of Object.entries(rec(d.baseRates))) {
    const cents = num(v);
    if (cents !== undefined) baseRates[k] = { cents, usd: usd(cents) };
  }
  const sub = d.subscription;
  const transactions = list(d.transactions);
  return {
    serviceAreaName: str(d.serviceAreaName),
    hasSubscription: flag(d.hasSubscription),
    subscription: sub === null || sub === undefined ? null : pickScalars(sub, ['planId', 'type', 'currentPeriodEnd', 'endAt']),
    baseRates,
    paymentMethods: list(d.paymentMethods).map((m) => {
      const r = rec(m);
      const card = rec(r.card);
      return {
        brand: str(card.brand),
        last4: str(card.last4),
        expMonth: num(card.exp_month),
        expYear: num(card.exp_year),
        isDefault: defaultId !== undefined && defaultId !== null && r.id === defaultId,
      };
    }),
    promoCodes: list(d.promoCodes).map((x) => {
      const r = rec(x);
      return { name: str(r.name), desc: str(r.desc), type: str(r.type), remainingCents: num(r.remainingAmt), remainingUsd: usd(r.remainingAmt), expiresOn: str(r.expiresOn) ?? null };
    }),
    transactionsTotal: transactions.length,
    transactions: transactions.slice(0, transactionsLimit).map((t) => {
      const r = rec(t);
      return {
        type: str(r.type),
        transactionDatetime: str(r.transactionDatetime),
        totalCents: num(r.total),
        totalUsd: usd(r.total),
        tipCents: num(r.tipAmount),
        tipUsd: usd(r.tipAmount),
        discountedCents: num(r.discountedAmount),
        discountedUsd: usd(r.discountedAmount),
        bookingId: num(r.bookingId),
        bookingStart: [r.bookingStartDate, r.bookingStartTime].filter(Boolean).join(' ') || undefined,
        bookingEnd: [r.bookingEndDate, r.bookingEndTime].filter(Boolean).join(' ') || undefined,
        sitter: str(r.sitterFullName),
      };
    }),
  };
}

function compactPayments(safe: unknown): unknown {
  const s = rec(safe);
  const baseRatesUsd: Rec = {};
  for (const [k, v] of Object.entries(rec(s.baseRates))) baseRatesUsd[k] = rec(v).usd;
  return {
    serviceAreaName: s.serviceAreaName,
    hasSubscription: s.hasSubscription,
    subscription: s.subscription,
    baseRatesUsd,
    paymentMethods: s.paymentMethods,
    promoCodes: list(s.promoCodes).map((x) => {
      const r = rec(x);
      return { name: r.name, desc: r.desc, remainingUsd: r.remainingUsd, expiresOn: r.expiresOn };
    }),
    transactionsTotal: s.transactionsTotal,
    transactions: list(s.transactions).map((t) => {
      const r = rec(t);
      return {
        date: r.transactionDatetime,
        type: r.type,
        totalUsd: r.totalUsd,
        ...(num(r.tipUsd) ? { tipUsd: r.tipUsd } : {}),
        ...(num(r.discountedUsd) ? { discountedUsd: r.discountedUsd } : {}),
        bookingId: r.bookingId,
        sitter: r.sitter,
      };
    }),
  };
}

// ------------------------------------------------------------------ tools

export function registerAccountTools(server: McpServer, client: JuggleClient): void {
  server.registerTool(
    'juggle_get_profile',
    {
      title: 'Get your Juggle family profile',
      description:
        "Show your Juggle (whyjuggle.com) family account profile: name, email, service area (city), membership/subscription status, unread message count, job stats (posted/completed/canceled, rating), saved addresses with their ids (needed to post a sit), pets, and the number of kids. Kids' names, birthdays, grades and allergies are included ONLY when include_kids is true. Never returns phone numbers, emergency contacts or house instructions, on any view.",
      annotations: toolAnnotations({ title: 'Get your Juggle family profile', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        include_kids: z.boolean().optional().describe("Also return each kid's name, birthday, gender, grade, hobbies, foods, allergies and notes (default false)."),
        view: viewInput(
          'compact: account basics, stats, one-line addresses with ids, pet names, kid count. "full" and "raw" both return the allowlisted profile (raw = indented) — never phone numbers, emergency contacts or house instructions.',
        ),
      }),
    },
    async ({ include_kids, view }) => {
      const page = await client.getPage('/my-profile');
      const safe = sanitizeProfile(page.data, page.user, include_kids === true);
      return respond(view, safe, { context: 'GET /my-profile', project: compactProfile });
    },
  );

  server.registerTool(
    'juggle_get_payments_summary',
    {
      title: 'Get Juggle payments, rates and transactions',
      description:
        "Show your Juggle payments overview: your city's hourly sitting rates and booking fee (babysitting by number of kids, petsitting by number of pets, multi-sitter), saved cards (brand, last 4, expiry, which is default), membership subscription, promo codes/credits remaining, and recent transactions (amount, tip, booking, sitter). Amounts are in US dollars (…Usd); full view adds the raw integer cents (…Cents). Read-only: never charges, tips or changes a card, and never returns Stripe secrets or card ids.",
      annotations: toolAnnotations({ title: 'Get Juggle payments, rates and transactions', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        transactions_limit: limitInput(20, 200, 'most recent transactions'),
        view: viewInput(
          'compact: dollar amounts only. "full" adds cents and booking start/end per transaction; "raw" is the same allowlisted object indented — Stripe keys, secrets and card ids are never returned.',
        ),
      }),
    },
    async ({ transactions_limit, view }) => {
      const page = await client.getPage('/payments');
      const safe = sanitizePayments(page.data, transactions_limit ?? 20);
      return respond(view, safe, { context: 'GET /payments', project: compactPayments });
    },
  );
}
