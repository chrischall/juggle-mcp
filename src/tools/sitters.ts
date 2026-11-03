import type { McpServer } from '@modelcontextprotocol/server';
import { IsoDate, IsoTime, McpToolError, UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { JuggleClient, PageQuery } from '../client.js';
import { SERVICES } from './bookings.js';
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
  strings,
  viewInput,
  type Rec,
} from './shared.js';

// ---------------------------------------------------------------- sitter list

function compactSitterItem(item: unknown): Rec {
  const s = rec(item);
  return {
    profileId: num(s.id),
    accountId: num(s.accountId),
    name: str(s.name),
    location: str(s.location),
    rating: num(s.rating),
    numJobsCompleted: num(s.numJobsCompleted),
    backgroundCheckCompleted: flag(s.backgroundCheckCompleted),
    isFavorite: flag(s.isFavorite),
    numFriends: num(s.numFriends),
  };
}

function sitterListResult(view: string | undefined, data: Rec, sitters: unknown[], route: string, note?: string) {
  const head = { totalNumSitters: num(data.totalNumSitters), returned: sitters.length, ...(note ? { note } : {}) };
  if (view === 'raw') return respond(view, { ...data, ...head, sitters }, { context: route });
  return respond(
    view,
    { ...head, sitters, filters: data.filters },
    { context: route, project: () => ({ ...head, sitters: sitters.map(compactSitterItem) }) },
  );
}

/** Most rows `GET /sitters` returns, whatever `numSitters` asks for (live 2026-11-03). */
const SITTER_PAGE_CAP = 200;

/**
 * Your favorite sitters. `favorites=1` is echoed by the site but NOT applied:
 * `/sitters` returns the city's sitters with favorites sorted first, capped at
 * 200 (live 2026-11-03, docs §3.8). So keep only rows explicitly flagged
 * `isFavorite`; `truncated` means all 200 rows were favorites and more may exist.
 */
export async function readFavorites(client: JuggleClient): Promise<{ data: Rec; favorites: Rec[]; truncated: boolean }> {
  const data = rec((await client.getPage('/sitters', { favorites: 1, numSitters: SITTER_PAGE_CAP })).data);
  const rows = requireList(data, 'sitters', '/sitters?favorites=1').map(rec);
  const favorites = rows.filter((s) => flag(s.isFavorite) === true);
  return { data, favorites, truncated: rows.length >= SITTER_PAGE_CAP && favorites.length === rows.length };
}

// -------------------------------------------------------------- sitter profile

/** The only `data.profile` columns ever copied — the row also holds the sitter's phone, birthdate, emergency contacts, conviction / maltreatment / disciplinary flags and facebook handle. */
const SITTER_PROFILE_FIELDS = [
  'bio',
  'college',
  'major',
  'hometown',
  'certifications',
  'age_specific_experience',
  'min_kid_age',
  'max_kid_age',
  'babysits',
  'petsits',
  'homeschools',
  'pet_experience',
  'homework_subjects',
  'will_help_with_homework',
  'valid_drivers_license',
  'usable_vehicle_available',
] as const;

/** The sitter page, ALLOWLISTED. This is the most that any rung returns. */
export function sanitizeSitter(data: unknown): Rec {
  const d = rec(data);
  const p = rec(d.profile);
  return {
    profileId: num(p.id),
    accountId: num(d.accountId),
    userId: num(d.userId),
    name: str(d.name),
    rating: num(p.rating),
    numJobsCompleted: num(d.numJobsCompleted),
    momApprovedSince: str(d.momApprovedSince),
    backgroundCheckCompleted: flag(d.backgroundCheckCompleted),
    isFavorite: flag(d.isFavorite),
    serviceAreaName: str(d.serviceAreaName),
    servicesOffered: strings(d.servicesOffered),
    childcareExperience: strings(d.childcareExperience),
    specialNeeds: strings(d.specialNeeds),
    higherEducation: strings(d.higherEducation),
    friendsThatHaveBooked: list(d.friendsThatHaveBooked).map((f) => pickScalars(f, ['id', 'url'])),
    canSendMsg: flag(d.canSendMsg),
    profile: pickScalars(p, SITTER_PROFILE_FIELDS),
  };
}

function compactSitter(safe: unknown): unknown {
  const s = rec(safe);
  const p = rec(s.profile);
  return {
    profileId: s.profileId,
    accountId: s.accountId,
    userId: s.userId,
    name: s.name,
    rating: s.rating,
    numJobsCompleted: s.numJobsCompleted,
    backgroundCheckCompleted: s.backgroundCheckCompleted,
    isFavorite: s.isFavorite,
    serviceAreaName: s.serviceAreaName,
    servicesOffered: s.servicesOffered,
    college: p.college,
    major: p.major,
    certifications: p.certifications,
    bio: p.bio,
    canSendMsg: s.canSendMsg,
  };
}

// ---------------------------------------------------------------- reviews

function compactReview(item: unknown): Rec {
  const r = rec(item);
  return { date: str(r.date), name: str(r.name), rating: num(r.rating), content: str(r.content), friend: flag(r.friend) };
}

export function registerSitterTools(server: McpServer, client: JuggleClient): void {
  server.registerTool(
    'juggle_list_sitters',
    {
      title: 'Find / search Juggle sitters',
      description:
        "Search the Juggle sitters (babysitters, petsitters, nannies — college-student 'Squad') in your city: name, location, rating, jobs completed, background check, whether they are a favorite and how many of your friends booked them. Optional filters: available on a date between start_time and end_time, services, keywords, name. Returns profileId (for juggle_get_sitter) and accountId (for favorites, reviews and booking invites). Use juggle_list_favorites for just your favorites.",
      annotations: toolAnnotations({ title: 'Find Juggle sitters', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        date: IsoDate.optional().describe('Only sitters available on this date (YYYY-MM-DD). Needs start_time and end_time.'),
        start_time: IsoTime.optional().describe('Availability window start, HH:MM 24h (with date).'),
        end_time: IsoTime.optional().describe('Availability window end, HH:MM 24h (with date).'),
        services: z.array(z.enum(SERVICES)).min(1).optional().describe('Only sitters offering these services.'),
        keywords: z.string().min(1).max(200).optional().describe('Keyword search over sitter profiles.'),
        name: z.string().min(1).max(100).optional().describe('Search by sitter name.'),
        limit: limitInput(20, 200, 'sitters'),
        view: viewInput(
          'compact: ids, name, location, rating, jobs completed, background check, favorite, friends. "full" returns the upstream sitter items and the filter echo; "raw" the whole page data.',
        ),
      }),
    },
    async ({ date, start_time, end_time, services, keywords, name, limit, view }) => {
      const window = [date, start_time, end_time].filter((v) => v !== undefined).length;
      if (window !== 0 && window !== 3) {
        throw new McpToolError('An availability filter needs all three of date, start_time and end_time.');
      }
      const query: PageQuery = { sittingDate: date, sittingStartTime: start_time, sittingEndTime: end_time, services, keywords, name, numSitters: limit ?? 20 };
      const page = await client.getPage('/sitters', query);
      const data = rec(page.data);
      return sitterListResult(view, data, requireList(data, 'sitters', '/sitters'), 'GET /sitters');
    },
  );

  server.registerTool(
    'juggle_list_favorites',
    {
      title: 'List your favorite Juggle sitters',
      description:
        "List the sitters you have marked as favorites on Juggle: name, location, rating, jobs completed, background check. Returns profileId (for juggle_get_sitter) and accountId (for reviews, unfavoriting and booking invites).",
      annotations: toolAnnotations({ title: 'List favorite Juggle sitters', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        view: viewInput('compact: ids, name, location, rating, jobs completed, background check. "full" returns the upstream sitter items; "raw" the whole page data.'),
      }),
    },
    async ({ view }) => {
      const { data, favorites, truncated } = await readFavorites(client);
      // data.totalNumSitters counts every sitter in the city, not your favorites.
      const { totalNumSitters: _all, ...rest } = data;
      return sitterListResult(view, rest, favorites, 'GET /sitters?favorites=1', truncated
        ? `Juggle returns at most ${SITTER_PAGE_CAP} sitters and all ${SITTER_PAGE_CAP} were favorites — there may be more.`
        : undefined);
    },
  );

  server.registerTool(
    'juggle_get_sitter',
    {
      title: "Get a Juggle sitter's profile",
      description:
        "Get one Juggle sitter's public profile: rating, jobs completed, 'mom approved' since, background check, services offered, childcare / special-needs experience, college and major, certifications, kid age range, pet experience, homework help, driver's license / car, bio, whether they are a favorite and whether you can message them. profile_id comes from juggle_list_sitters, juggle_list_favorites or a booking's applicants. Private details (phone, birthdate, emergency contacts, background-check answers, social handles) are never returned on any view." +
        ' ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: "Get a Juggle sitter's profile", readOnly: true, openWorld: true }),
      inputSchema: z.object({
        profile_id: JuggleId.describe("The sitter's profileId (NOT accountId)."),
        view: viewInput(
          'compact: ids, rating, services, school, certifications, bio. "full" adds the rest of the allowlisted profile (experience lists, age range, pets, driving, friends who booked); "raw" is that same allowlisted object indented — never the upstream row, which holds private fields.',
        ),
      }),
    },
    async ({ profile_id, view }) => {
      const page = await client.getPage(`/sitters/${profile_id}`);
      return respond(view, sanitizeSitter(page.data), {
        context: `GET /sitters/${profile_id}`,
        project: compactSitter,
        untrustedNote: UNTRUSTED_NOTES.sitter,
      });
    },
  );

  server.registerTool(
    'juggle_get_reviews',
    {
      title: 'Get reviews of a Juggle sitter',
      description:
        "Read the reviews other families left for a Juggle sitter (date, reviewer, star rating, text, whether the reviewer is your friend), newest as Juggle orders them, with the total count and average rating. account_id is the sitter's accountId (from juggle_list_sitters, juggle_get_sitter or a booking)." +
        ' ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get Juggle sitter reviews', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        account_id: JuggleId.describe("The sitter's accountId (NOT profileId)."),
        limit: limitInput(20, 100, 'reviews'),
        offset: offsetInput('reviews'),
        view: viewInput('compact: date, reviewer, rating, text, friend. "full" returns the upstream review items for the page; "raw" the same, indented.'),
      }),
    },
    async ({ account_id, limit, offset, view }) => {
      const route = `/reviews/${account_id}`;
      const page = await client.getPage(route);
      const data = rec(page.data);
      const reviews = requireList(data, 'reviews', route);
      const ratings = reviews.map((r) => num(rec(r).rating)).filter((n): n is number => n !== undefined);
      const start = offset ?? 0;
      const slice = reviews.slice(start, start + (limit ?? 20));
      const head = {
        reviewedName: str(data.reviewedName),
        total: reviews.length,
        averageRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null,
        offset: start,
        returned: slice.length,
      };
      return respond(view, { ...head, reviews: slice }, {
        context: `GET ${route}`,
        project: () => ({ ...head, reviews: slice.map(compactReview) }),
        untrustedNote: UNTRUSTED_NOTES.reviews,
      });
    },
  );
}
