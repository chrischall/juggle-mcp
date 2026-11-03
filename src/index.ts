#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';
import { JuggleClient } from './client.js';
import { VERSION } from './version.js';
import { toolRegistrars } from './tools/index.js';

// Load `.env` beside the package for a local install; real env vars win.
try {
  await loadDotenvSafely({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: false });
} catch {
  /* no filesystem-relative .env in this runtime */
}

// Built ONCE, outside the registrars: runMcp constructs a server instance per
// served connection, and the session must be shared. Constructing without
// credentials is fine — the config error surfaces on the first tool call, so
// the server still answers the host's install-time tools/list probe.
const client = new JuggleClient();

await runMcp({
  name: 'juggle-mcp',
  version: VERSION,
  banner: `[juggle-mcp] v${VERSION} — Juggle (whyjuggle.com) family account via email/password sign-in. This project was developed and is maintained by AI (Claude). Use at your own discretion.`,
  deps: client,
  tools: toolRegistrars,
});
