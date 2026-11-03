import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { JuggleClient } from '../client.js';
import { registerAccountTools } from './account.js';
import { registerBookingTools } from './bookings.js';
import { registerHealthcheckTools } from './healthcheck.js';
import { registerLocationTools } from './locations.js';
import { registerMessageTools } from './messages.js';
import { registerSitterTools } from './sitters.js';
import { registerWriteTools } from './writes.js';

/**
 * Every tool registrar, in order. index.ts serves exactly this list and the
 * roster/annotation tests drive exactly this list, so a new module added here
 * is covered by both.
 */
export const toolRegistrars: ToolRegistrar<JuggleClient>[] = [
  registerHealthcheckTools,
  registerAccountTools,
  registerBookingTools,
  registerSitterTools,
  registerMessageTools,
  registerLocationTools,
  registerWriteTools,
];
