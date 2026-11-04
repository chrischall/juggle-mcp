/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, context-groups spec D4), and the `view: "brief"` rung the
 * group's canonical reads answer. Inert data to any other client: one extra
 * `_meta` key. The shape is fixed by the host's contract, so it is restated
 * here rather than imported — this server takes no dependency on mcp-host.
 *
 * `subject` and `when` would name THIS tool's own argument names; Juggle has
 * neither (one family account, nothing listable as a subject, and no reads
 * that take a date range), so no hint here carries them. `aliases` are
 * lowercase, at most 8, each at most 40 chars.
 */
import { untrustedEnvelope, viewParam, type View } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export type MintIntent = 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'family';
  intent: MintIntent;
  canonical?: true;
  aliases?: string[];
}

export type MintMeta = { mint: MintHint };

/** `_meta` for a Juggle tool: every tool here is in the `family` group. */
export function familyMeta(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): MintMeta {
  return { mint: { domain: 'family', intent, ...extra } };
}

/**
 * `server` with every `registerTool` call carrying `meta` as its `_meta`.
 * mcp-utils' `registerWrite` registers the tool itself and takes no `_meta`,
 * so a gated write is registered through this view of the server. Only
 * `registerTool` is changed; everything else is the server's own.
 * (No `<prefix>_batch` tool exists here — if one is added, register the
 * writes on the real server and attach the hints another way, since
 * `registerBatchTool` finds writes by the server object they were given.)
 */
export function withMeta(server: McpServer, meta: MintMeta): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (name: string, config: Record<string, unknown>, cb: unknown) =>
          (target.registerTool as (n: string, c: Record<string, unknown>, h: unknown) => unknown)(
            name,
            { ...config, _meta: { ...(config._meta as Record<string, unknown> | undefined), ...meta } },
            cb,
          );
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The longest a brief line may be. */
export const BRIEF_MAX = 120;

const BRIEF_NOTE =
  '"brief": one line per item, `title — <ISO date or "no date"> — <status>`, at most 120 chars each, in the untrusted-data envelope; a line starting "-- " is a note (`-- N of M shown`, `-- none`).';

/** The `view` parameter of a canonical read: the tool's own rungs plus `brief`. */
export function briefViewInput(rungs: readonly View[], note: string) {
  const base = viewParam(rungs);
  return z
    .enum([...rungs, 'brief'] as readonly string[] as [string, ...string[]])
    .optional()
    .describe(`${base.description ?? ''} ${note} ${BRIEF_NOTE}`.trim());
}

/** Whitespace in a third party's text collapsed, so one item stays one line. */
export function flat(s: string | undefined | null): string | undefined {
  const out = s?.replace(/\s+/g, ' ').trim();
  return out ? out : undefined;
}

/** Juggle's `YYYY-MM-DD HH:MM:SS` (site-local) as `YYYY-MM-DDTHH:MM`; else "no date". */
export function briefDate(v: unknown): string {
  if (typeof v !== 'string') return 'no date';
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v.trim());
  if (!m) return 'no date';
  return m[2] ? `${m[1]}T${m[2]}` : m[1];
}

/** `title — date — status`, the title cut with an ellipsis to keep the line ≤ 120. */
export function briefLine(title: string | undefined, date: string, status: string): string {
  const tail = ` — ${date} — ${status}`;
  const shown = flat(title) ?? '(untitled)';
  const room = BRIEF_MAX - tail.length;
  return `${shown.length > room ? `${shown.slice(0, Math.max(room - 1, 0))}…` : shown}${tail}`;
}

/**
 * The brief answer: item lines plus the notes the other rungs would carry —
 * `-- none` for an empty result, `-- N of M shown` for a partial page — inside
 * the fleet's untrusted-data envelope (`data: string[]`), because the lines
 * carry names and text other Juggle users wrote. `untrustedNote` is the
 * tool's own note (`UNTRUSTED_NOTES`), which already ends with the rule.
 */
export function briefResponse(lines: string[], shown: number, total: number, untrustedNote: string): CallToolResult {
  const notes: string[] = [];
  if (total === 0) notes.push('-- none');
  else if (shown < total) notes.push(`-- ${shown} of ${total} shown`);
  const payload = untrustedEnvelope([...lines, ...notes], { note: untrustedNote });
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
