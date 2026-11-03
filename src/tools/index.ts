import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { JuggleClient } from '../client.js';
import { registerHealthcheckTools } from './healthcheck.js';

/**
 * Every tool registrar, in order. index.ts serves exactly this list and the
 * roster/annotation tests drive exactly this list, so a new module added here
 * is covered by both.
 */
export const toolRegistrars: ToolRegistrar<JuggleClient>[] = [registerHealthcheckTools];
