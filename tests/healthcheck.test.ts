import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { CredentialHealthcheckResult } from '@chrischall/mcp-utils/healthcheck';
import { JuggleClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { BASE, FakeSite, PASSWORD, makeClient } from './helpers.js';

async function run(client: JuggleClient): Promise<CredentialHealthcheckResult> {
  const h = await createTestHarness((s) => registerHealthcheckTools(s, client));
  try {
    return parseToolResult<CredentialHealthcheckResult>(await h.callTool('juggle_healthcheck', {}));
  } finally {
    await h.close();
  }
}

describe('juggle_healthcheck', () => {
  it('is registered read-only', async () => {
    const h = await createTestHarness((s) => registerHealthcheckTools(s, makeClient(new FakeSite())));
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['juggle_healthcheck']);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true });
    await h.close();
  });

  it('reports no_credential WITHOUT probing when nothing is configured', async () => {
    vi.stubEnv('JUGGLE_EMAIL', '');
    vi.stubEnv('JUGGLE_PASSWORD', '');
    const site = new FakeSite();
    const res = await run(new JuggleClient({ baseUrl: BASE, fetchImpl: site.fetch }));
    vi.unstubAllEnvs();
    expect(res.ok).toBe(false);
    expect(res.credential.resolved).toBe(false);
    expect(res.hint).toMatch(/JUGGLE_EMAIL and JUGGLE_PASSWORD/);
    expect(site.requests).toHaveLength(0);
  });

  it('reports ok after signing in and reading the home page — never echoing the password', async () => {
    const site = new FakeSite();
    const res = await run(makeClient(site));
    expect(res.ok).toBe(true);
    expect(res.credential).toMatchObject({ source: 'env', resolved: true });
    expect(res.credential.detail).toMatchObject({ email: 'p***@example.com', site: 'juggle.test' });
    expect(JSON.stringify(res)).not.toContain(PASSWORD.trim());
    expect(site.count('POST', '/log-in')).toBe(1);
  });

  it('reports credential_rejected when Juggle refuses the password', async () => {
    const site = new FakeSite();
    site.loginResult = 'rejected';
    const res = await run(makeClient(site));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('credential_rejected');
    expect(res.hint).toMatch(/never retries a rejected password/);
  });
});
