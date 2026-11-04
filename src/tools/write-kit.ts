// Shared pieces of the confirm-gated write tools. Each write is a
// `defineWrite` — `plan` validates and does a fresh read, `execute` sends once —
// registered with `registerWrite`, so the preview / confirmToken gate is the
// shared one from @chrischall/mcp-utils.

import {
  CONFIRM_INJECTION_RULE,
  minifiedResult,
  registerWrite,
  toolAnnotations,
  writeOrUnknown,
  type WriteDefinition,
} from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { familyMeta, withMeta, type MintMeta } from './hints.js';

/**
 * Annotations for a write. `destructive` follows the fleet rule: is there an
 * INVERSE in this tool set, and does the write reach another person? Every
 * Juggle write but favorite/unfavorite reaches a sitter (notified, booked,
 * declined, messaged, reviewed) and has no undo here, so it is destructive.
 */
export function writeAnnotations(title: string, destructive: boolean) {
  return toolAnnotations({ title, readOnly: false, destructive, openWorld: true });
}

/**
 * A write tool's description with the prompt-injection rule appended
 * (`registerWrite` appends the confirm-flow sentence itself). This server also
 * returns third-party text (messages, reviews, sitter bios), so every write
 * carries the rule.
 */
export function writeDescription(text: string): string {
  return `${text} ${CONFIRM_INJECTION_RULE}`;
}

/** What a write reports when Juggle never confirmed whether it happened. */
export interface UnknownOutcome {
  status: 'unknown';
  warning: string;
}

/**
 * Send a write once. A `WriteOutcomeUnknownError` (sent, then a 5xx or a
 * dropped connection) becomes an `unknown` outcome naming where to check,
 * instead of an error that reads as "safe to retry" — the confirm token is
 * already spent, and a retry could post the job or send the message twice.
 */
export async function sendOnce<T>(run: () => Promise<T>, what: string, checkWith: string): Promise<T | UnknownOutcome> {
  const outcome = await writeOrUnknown(run, (_err, reason): UnknownOutcome => ({
    status: 'unknown',
    warning:
      `Juggle did not confirm this ${what} (${reason}), so it may already have gone through. ` +
      `Check ${checkWith} before retrying; do not resend blindly.`,
  }));
  return outcome.ok ? outcome.value : outcome.result;
}

/** A write's result as compact JSON. */
export function writeResult(result: unknown): CallToolResult {
  return minifiedResult(result);
}

/**
 * Each write's context-group hint. Posting a sit, booking/declining a sitter,
 * cancelling, favoriting and reviewing CHANGE the family's Juggle state;
 * messaging a sitter is a SEND. A write is never canonical.
 */
export const WRITE_HINTS: Readonly<Record<string, MintMeta>> = {
  juggle_post_job: familyMeta('change', { aliases: ['book a babysitter', 'book a sitter', 'find a sitter for', 'post a sit', 'pet sitter'] }),
  juggle_accept_sitter: familyMeta('change', { aliases: ['book the sitter', 'accept the babysitter'] }),
  juggle_decline_sitter: familyMeta('change', { aliases: ['decline the sitter', 'turn down the sitter'] }),
  juggle_cancel_booking: familyMeta('change', { aliases: ['cancel the babysitter', 'cancel the sit'] }),
  juggle_send_message: familyMeta('send', { aliases: ['message the sitter', 'text the babysitter', 'tell the sitter'] }),
  juggle_favorite_sitter: familyMeta('change', { aliases: ['favorite the sitter'] }),
  juggle_unfavorite_sitter: familyMeta('change', { aliases: ['unfavorite the sitter'] }),
  juggle_leave_review: familyMeta('change', { aliases: ['review the sitter', 'rate the babysitter'] }),
};

/**
 * `registerWrite` with the write's `_meta.mint` attached (mcp-utils'
 * `registerWrite` takes no `_meta`). A write missing from `WRITE_HINTS` is a
 * registration-time error, so a new write cannot ship unhinted.
 */
export function registerHintedWrite<Schema extends z.ZodObject, State, Result>(
  server: McpServer,
  def: WriteDefinition<Schema, State, Result>,
): void {
  const meta = WRITE_HINTS[def.name];
  if (!meta) throw new Error(`${def.name} has no context-group hint in WRITE_HINTS.`);
  registerWrite(withMeta(server, meta), def);
}
