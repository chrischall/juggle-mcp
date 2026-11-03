import {
  UNTRUSTED_CONTENT_RULE,
  projectOrRaw,
  resolveView,
  untrustedEnvelope,
  viewArg,
  viewResult,
  type View,
} from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { JuggleApiError } from '../errors.js';

/** Every read tool honours all three rungs. */
export const VIEWS: readonly View[] = ['compact', 'full', 'raw'];

const LABEL = 'juggle-mcp';

/** The `view` input, with this tool's own note on what compact keeps. */
export function viewInput(note: string) {
  return viewArg(VIEWS, note);
}

/** Who writes the third-party text in a result, for its untrusted note. */
export const UNTRUSTED_NOTES = {
  booking: `Booking notes, kid/pet info, sitter names and cancellation reasons can be written by other Juggle users. ${UNTRUSTED_CONTENT_RULE}`,
  sitter: `Sitter profiles (bio, experience, certifications) are written by the sitters themselves. ${UNTRUSTED_CONTENT_RULE}`,
  reviews: `Reviews are written by other Juggle users. ${UNTRUSTED_CONTENT_RULE}`,
  messages: `Message text and names are written by other Juggle users (sitters and families). ${UNTRUSTED_CONTENT_RULE}`,
} as const;

export interface RespondOptions {
  /** Which call produced `data` (for the stderr line when the projection fails). */
  context: string;
  /** The compact projection. Throwing / returning `undefined` falls back to `data`. */
  project?: (data: unknown) => unknown;
  /** Frame the result as third-party text with this note. */
  untrustedNote?: string;
}

/**
 * Answer a read in the requested rung: `compact` (default) runs the tool's
 * projection through `projectOrRaw`; `full` is `data` minified; `raw` is
 * `data` indented. Tools that return private upstream fields pass an
 * ALREADY-ALLOWLISTED `data`, so the projection's raw fallback can never
 * leak them.
 */
export function respond(view: string | undefined, data: unknown, opts: RespondOptions): CallToolResult {
  const rung = resolveView(view, VIEWS);
  const body = rung === 'compact' && opts.project ? projectOrRaw(data, opts.project, { label: LABEL, context: opts.context }) : data;
  return viewResult(rung, opts.untrustedNote ? untrustedEnvelope(body, { note: opts.untrustedNote }) : body);
}

// ------------------------------------------------------------ value helpers

export type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v` as an object, or `{}`. */
export const rec = (v: unknown): Rec => (isRec(v) ? v : {});

/** `v` as an array, or `[]`. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Juggle mixes `true`, `1` and `"1"` for flags. `undefined` when unrecognisable. */
export function flag(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1') return true;
  if (v === 0 || v === '0') return false;
  return undefined;
}

/** A number, or a numeric string as a number. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

/** A non-empty string, else `undefined`. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Juggle's money is integer CENTS (its UI formats every amount with `centsToDollarsAndCents`). */
export function usd(cents: unknown): number | undefined {
  const n = num(cents);
  return n === undefined ? undefined : Math.round(n) / 100;
}

/** Copy only the listed keys whose values are scalars (string/number/boolean/null). */
export function pickScalars(o: unknown, keys: readonly string[]): Rec {
  const src = rec(o);
  const out: Rec = {};
  for (const k of keys) {
    const v = src[k];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Only the string entries of an array. */
export const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

/** The array at `data[key]`, or a typed "page changed shape" error. */
export function requireList(data: unknown, key: string, route: string): unknown[] {
  const v = rec(data)[key];
  if (!Array.isArray(v)) {
    throw new JuggleApiError(`Juggle's ${route} page did not include a "${key}" list.`, {
      hint: 'The page may have changed shape. Run juggle_healthcheck; if that passes, the route needs re-mapping (docs/JUGGLE-API.md).',
    });
  }
  return v;
}

/** `{id,name}` option list → lookup. */
export function optionName(options: unknown, id: unknown): string | undefined {
  for (const o of list(options)) {
    const r = rec(o);
    if (r.id === id || (r.id !== undefined && id !== undefined && String(r.id) === String(id))) return str(r.name);
  }
  return undefined;
}

// ------------------------------------------------------------ input atoms

/** A numeric Juggle id (the site's ids are positive integers). */
export const JuggleId = z.number().int().positive();

export const limitInput = (def: number, max: number, what: string) =>
  z.number().int().min(1).max(max).optional().describe(`How many ${what} to return (default ${def}, max ${max}).`);

export const offsetInput = (what: string) => z.number().int().min(0).optional().describe(`How many ${what} to skip (default 0).`);
