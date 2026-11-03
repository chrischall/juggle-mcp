// Shared pieces of the confirm-gated write tools. Each write is a
// `defineWrite` — `plan` validates and does a fresh read, `execute` sends once —
// registered with `registerWrite`, so the preview / confirmToken gate is the
// shared one from @chrischall/mcp-utils.

import { CONFIRM_INJECTION_RULE, minifiedResult, toolAnnotations, writeOrUnknown } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';

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
