import { McpToolError, type McpToolErrorKind } from '@chrischall/mcp-utils';

/**
 * Juggle refused the email/password (`POST /log-in` answered `{error: true}`
 * or a 422). Cached as PERMANENT by the session manager: a rejected password
 * is never retried automatically, so repeated tool calls cannot lock the
 * account. Fixing it needs new config (a restart / reconnect).
 */
export class JuggleCredentialRejectedError extends McpToolError {
  constructor(message = 'Juggle rejected the email/password.') {
    super(message, {
      kind: 'credential_rejected',
      hint: 'Check JUGGLE_EMAIL / JUGGLE_PASSWORD (your whyjuggle.com family sign-in) and restart or reconnect. A rejected password is not retried automatically, so the account cannot be locked by repeated attempts. Google/Facebook-only sign-ins are not supported: set a password on whyjuggle.com first.',
    });
    this.name = 'JuggleCredentialRejectedError';
  }
}

/** The session expired and one re-login + replay did not recover it. */
export class JuggleSessionError extends McpToolError {
  constructor(message: string, status?: number) {
    super(message, {
      kind: 'session_expired',
      status,
      hint: 'Retry once. If it keeps happening, run juggle_healthcheck — the sign-in may be failing.',
    });
    this.name = 'JuggleSessionError';
  }
}

/**
 * A request Juggle answered but refused: a non-2xx (other than an expiry), or
 * a 2xx whose JSON body says `{error: true, msg}` — Juggle reports business
 * failures that way with HTTP 200, so a 200 is not success until `error` is
 * checked. `serverMessage` is Juggle's own text, already redacted.
 */
export class JuggleApiError extends McpToolError {
  readonly serverMessage?: string;
  constructor(message: string, opts: { status?: number; kind?: McpToolErrorKind; hint?: string; serverMessage?: string; cause?: unknown } = {}) {
    super(message, { status: opts.status, kind: opts.kind ?? 'http', hint: opts.hint, cause: opts.cause });
    this.name = 'JuggleApiError';
    this.serverMessage = opts.serverMessage;
  }
}
