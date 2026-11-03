import type { McpServer } from '@modelcontextprotocol/server';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { JuggleClient } from '../client.js';

/**
 * `juggle_healthcheck`: is a sign-in configured, does Juggle accept it, and
 * does an authenticated page read round-trip? The probe runs the SAME session
 * path every tool uses (getPage → login on first use), and reports failure only
 * by throwing — a signed-out answer surfaces as a typed session/credential
 * error, never as a healthy 200.
 */
export function registerHealthcheckTools(server: McpServer, client: JuggleClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'juggle',
    hostLabel: new URL(client.baseUrl).host,
    probePath: '/',
    resolveCredential: async () => client.describeCredential(),
    probeFn: async () => {
      const page = await client.getPage('/');
      return { page: page.meta.page ?? null, account_type: page.user?.type ?? null };
    },
    hints: {
      no_credential:
        'No Juggle sign-in configured. Set JUGGLE_EMAIL and JUGGLE_PASSWORD (your whyjuggle.com family account), or reconnect the connector and enter them.',
      credential_rejected:
        'Juggle rejected the email/password. Fix it and restart (or reconnect the connector). This server never retries a rejected password automatically.',
    },
  });
}
