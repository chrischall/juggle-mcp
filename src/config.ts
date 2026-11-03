import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';

/** The production site. Overridable only for tests / a local stub server. */
export const DEFAULT_BASE_URL = 'https://whyjuggle.com';

export interface JuggleConfig {
  email: string;
  password: string;
  /** Origin only (scheme + host + port), no trailing slash. */
  baseUrl: string;
}

export interface ConfigInput {
  email?: string;
  password?: string;
  baseUrl?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validate a base URL and reduce it to its origin. The password is POSTed
 * there, so anything but https is refused — except loopback, which is what the
 * test suite and a local stub server use.
 */
export function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpToolError(`JUGGLE_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`, {
      kind: 'no_credential',
      hint: `Unset JUGGLE_BASE_URL to use ${DEFAULT_BASE_URL}.`,
    });
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new McpToolError(`JUGGLE_BASE_URL must be https (got ${url.protocol}//${url.host})`, {
      kind: 'no_credential',
      hint: `Your password is sent to this host. Unset JUGGLE_BASE_URL to use ${DEFAULT_BASE_URL}.`,
    });
  }
  if (url.username || url.password) {
    throw new McpToolError('JUGGLE_BASE_URL must not carry credentials', { kind: 'no_credential' });
  }
  return url.origin;
}

/**
 * Read the configuration, never throwing: a missing/invalid value becomes a
 * `configError` that the client re-throws on the first tool call, so the
 * server still boots and answers the host's install-time tools/list probe.
 */
export function readConfig(input: ConfigInput = {}): { config: JuggleConfig | null; configError: McpToolError | null; email: string | undefined; password: string | undefined } {
  const email = input.email ?? readEnvVar('JUGGLE_EMAIL');
  // Passwords keep leading/trailing whitespace: it may be part of the secret.
  const password = input.password ?? readEnvVar('JUGGLE_PASSWORD', { trim: false });
  const rawBase = input.baseUrl ?? readEnvVar('JUGGLE_BASE_URL') ?? DEFAULT_BASE_URL;

  let baseUrl: string;
  try {
    baseUrl = normaliseBaseUrl(rawBase);
  } catch (err) {
    return { config: null, configError: err as McpToolError, email, password };
  }
  if (!email || !password) {
    const missing = [!email && 'JUGGLE_EMAIL', !password && 'JUGGLE_PASSWORD'].filter(Boolean).join(' and ');
    return {
      config: null,
      configError: new McpToolError(`${missing} ${missing.includes(' and ') ? 'are' : 'is'} not set`, {
        kind: 'no_credential',
        hint: 'Set JUGGLE_EMAIL and JUGGLE_PASSWORD (your whyjuggle.com family sign-in) in .env or the MCP host environment, or reconnect the connector and enter them.',
      }),
      email,
      password,
    };
  }
  return { config: { email, password, baseUrl }, configError: null, email, password };
}
