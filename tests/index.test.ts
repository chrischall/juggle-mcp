import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNTRUSTED_DESCRIPTION_SUFFIX } from '@chrischall/mcp-utils';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { toolRegistrars } from '../src/tools/index.js';
import { FakeSite, makeClient } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function servedTools() {
  const client = makeClient(new FakeSite());
  const h = await createTestHarness(async (s) => {
    for (const register of toolRegistrars) await register(s, client);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools;
}

describe('tool roster', () => {
  it('manifest.json tools[] equals the served roster, in both directions, with real descriptions', async () => {
    const served = (await servedTools()).map((t) => t.name).sort();
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as { tools: { name: string; description: string }[] };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(served);
    for (const t of manifest.tools) expect(t.description.trim().length, t.name).toBeGreaterThan(10);
  });

  it('every tool is juggle_-prefixed and described', async () => {
    for (const t of await servedTools()) {
      expect(t.name).toMatch(/^juggle_[a-z_]+$/);
      expect((t.description ?? '').length, t.name).toBeGreaterThan(20);
    }
  });
});

const UNTRUSTED_TOOLS = [
  'juggle_get_booking',
  'juggle_get_sitter',
  'juggle_get_reviews',
  'juggle_list_conversations',
  'juggle_get_conversation',
];

describe('untrusted-output warnings', () => {
  it('every tool returning third-party text says so at the end of its description', async () => {
    const tools = await servedTools();
    for (const name of UNTRUSTED_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect((t!.description ?? '').endsWith(` ${UNTRUSTED_DESCRIPTION_SUFFIX}`), name).toBe(true);
    }
  });

  it('tools that return no third-party text do not carry the warning', async () => {
    for (const t of await servedTools()) {
      if (UNTRUSTED_TOOLS.includes(t.name)) continue;
      expect(t.description ?? '', t.name).not.toContain(UNTRUSTED_DESCRIPTION_SUFFIX);
    }
  });
});

describe('tool annotations', () => {
  it('every tool is annotated truthfully: reads never destroy, writes state destructiveHint explicitly', async () => {
    for (const t of await servedTools()) {
      const a = t.annotations ?? {};
      expect(typeof a.readOnlyHint, `${t.name} readOnlyHint`).toBe('boolean');
      expect(typeof a.openWorldHint, `${t.name} openWorldHint`).toBe('boolean');
      if (a.readOnlyHint) {
        expect(a.destructiveHint ?? false, `${t.name} is a read`).toBe(false);
      } else {
        // destructiveHint defaults to TRUE when omitted, so silence must fail.
        expect(typeof a.destructiveHint, `${t.name} destructiveHint`).toBe('boolean');
        const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
        expect(props, `${t.name} must be confirm-gated`).toContain('confirmToken');
      }
    }
  });
});
