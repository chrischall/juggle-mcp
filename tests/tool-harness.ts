import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { JuggleClient } from '../src/client.js';
import { toolRegistrars } from '../src/tools/index.js';
import { FakeSite, authedPage, makeClient, page } from './helpers.js';

export interface ToolCall {
  /** The tool result's text (the JSON the model sees). */
  text: string;
  /** `text` parsed. */
  json: Record<string, unknown>;
  isError: boolean;
}

/** Serve every registrar against `client` and call one tool. */
export async function callTool(client: JuggleClient, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  const h = await createTestHarness(async (s) => {
    for (const register of toolRegistrars) await register(s, client);
  });
  try {
    const res = (await h.callTool(name, args)) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (res.content ?? []).map((c) => c.text ?? '').join('');
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* error text */
    }
    return { text, json, isError: res.isError === true };
  } finally {
    await h.close();
  }
}

/** A FakeSite serving `data` as the page `pageName` at `GET path` (signed-in only). */
export function siteWith(routes: Record<string, [pageName: string, data: object]>): FakeSite {
  const site = new FakeSite();
  for (const [path, [pageName, data]] of Object.entries(routes)) site.on('GET', path, authedPage(page(pageName, data)));
  return site;
}

export { makeClient };
