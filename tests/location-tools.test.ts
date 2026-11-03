import { describe, expect, it, vi } from 'vitest';
import { JuggleClient } from '../src/client.js';
import { locationsData } from './fixtures.js';
import { BASE, FakeSite, page } from './helpers.js';
import { callTool } from './tool-harness.js';

type Rec = Record<string, unknown>;

function publicSite(): FakeSite {
  // Public page: served to anyone, no session needed.
  return new FakeSite().on('GET', '/locations', { body: page('Locations', locationsData, { user: null }) });
}

describe('juggle_list_locations', () => {
  it('works with NO credentials configured and never signs in', async () => {
    vi.stubEnv('JUGGLE_EMAIL', '');
    vi.stubEnv('JUGGLE_PASSWORD', '');
    try {
      const s = publicSite();
      const r = await callTool(new JuggleClient({ baseUrl: BASE, fetchImpl: s.fetch }), 'juggle_list_locations');
      expect(r.isError).toBe(false);
      expect(s.count('POST', '/log-in')).toBe(0);
      expect(s.count('GET', '/log-in')).toBe(0);
      expect(r.json.locations).toEqual([
        { state: 'North Carolina', city: 'Testville', details: 'Email: support@example.com Babysitting Rates: 1 kid—$20/hour' },
        { state: 'Kentucky', city: 'Otherburg', details: 'Petsitting Rates: 1 pet—$20/hour' },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('filters by state, case-insensitively', async () => {
    const s = publicSite();
    const r = await callTool(new JuggleClient({ baseUrl: BASE, fetchImpl: s.fetch, email: 'a@example.com', password: 'x' }), 'juggle_list_locations', { state: 'kentucky' });
    expect((r.json.locations as Rec[]).map((l) => l.city)).toEqual(['Otherburg']);
  });
});
