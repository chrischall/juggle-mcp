import type { McpServer } from '@modelcontextprotocol/server';
import { stripHtml, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { JuggleClient } from '../client.js';
import { isRec, list, rec, respond, str, viewInput, type Rec } from './shared.js';

/** Juggle's own rate prose (first-party HTML) → one readable line. */
function readable(html: unknown): string | undefined {
  const s = str(html);
  return s === undefined ? undefined : stripHtml(s).replace(/\s+([:;,.])/g, '$1').trim();
}

export function registerLocationTools(server: McpServer, client: JuggleClient): void {
  server.registerTool(
    'juggle_list_locations',
    {
      title: 'List Juggle cities and their sitting rates',
      description:
        "List the cities Juggle serves (by state) with each city's published babysitting and petsitting hourly rates and support email, from Juggle's public Locations page. Needs no sign-in. Optional state filter (e.g. \"North Carolina\").",
      annotations: toolAnnotations({ title: 'List Juggle cities and rates', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        state: z.string().min(2).max(60).optional().describe('Only this US state (full name, case-insensitive).'),
        view: viewInput('compact: state, city and the rate text as plain text. "full" returns the upstream state → locations map (rates as HTML); "raw" the same, indented.'),
      }),
    },
    async ({ state, view }) => {
      const page = await client.getPage('/locations', undefined, { auth: false });
      const states = rec(rec(page.data).states);
      const wanted = state?.trim().toLowerCase();
      const kept: Rec = {};
      for (const [name, entry] of Object.entries(states)) {
        if (!wanted || name.toLowerCase() === wanted) kept[name] = entry;
      }
      return respond(view, { states: kept }, {
        context: 'GET /locations',
        project: () => ({
          locations: Object.entries(kept).flatMap(([name, entry]) =>
            list(isRec(entry) ? entry.locations : undefined).map((l) => ({ state: name, city: str(rec(l).city), details: readable(rec(l).details) })),
          ),
        }),
      });
    },
  );
}
