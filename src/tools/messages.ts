import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { JuggleClient } from '../client.js';
import { JuggleId, UNTRUSTED_NOTES, flag, limitInput, num, offsetInput, rec, requireList, respond, str, viewInput, type Rec } from './shared.js';

function compactConversation(item: unknown): Rec {
  const c = rec(item);
  return {
    conversationId: num(c.id),
    name: str(c.name),
    lastMessage: str(c.lastMessage),
    lastMessageAt: str(c.messageCreatedAt),
    unread: num(c.numUnreadMsgs),
  };
}

function compactMessage(item: unknown): Rec {
  const m = rec(item);
  return { id: num(m.id), from: str(m.name), mine: flag(m.myMessage), sentAt: str(m.sentAt), type: str(m.type), content: str(m.content) };
}

export function registerMessageTools(server: McpServer, client: JuggleClient): void {
  server.registerTool(
    'juggle_list_conversations',
    {
      title: 'List your Juggle message conversations',
      description:
        "List your Juggle message conversations (inbox / chats with sitters): who, the last message, when, and how many unread messages each has. Returns conversationId for juggle_get_conversation. unread_only keeps just the conversations with unread messages." +
        ' ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List Juggle conversations', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        unread_only: z.boolean().optional().describe('Only conversations with unread messages (default false).'),
        limit: limitInput(50, 200, 'conversations'),
        offset: offsetInput('conversations'),
        view: viewInput('compact: conversationId, name, last message, when, unread count. "full" returns the upstream conversation items; "raw" the same, indented.'),
      }),
    },
    async ({ unread_only, limit, offset, view }) => {
      const page = await client.getPage('/messages');
      const data = rec(page.data);
      const all = requireList(data, 'conversations', '/messages');
      const matched = unread_only ? all.filter((c) => (num(rec(c).numUnreadMsgs) ?? 0) > 0) : all;
      const start = offset ?? 0;
      const slice = matched.slice(start, start + (limit ?? 50));
      const head = { numMessages: num(data.numMessages), total: matched.length, offset: start, returned: slice.length };
      return respond(view, { ...head, conversations: slice }, {
        context: 'GET /messages',
        project: () => ({ ...head, conversations: slice.map(compactConversation) }),
        untrustedNote: UNTRUSTED_NOTES.messages,
      });
    },
  );

  server.registerTool(
    'juggle_get_conversation',
    {
      title: 'Read a Juggle message conversation',
      description:
        "Read the messages in one Juggle conversation (chat with a sitter): sender, whether you sent it, time, and text — the most recent `limit` messages, oldest first; page further back with offset. conversation_id comes from juggle_list_conversations. Opening a conversation is what the website does to show it, so Juggle may mark its messages as read, exactly as viewing it on whyjuggle.com would." +
        ' ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Read a Juggle conversation', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        conversation_id: JuggleId.describe('The conversation id (conversationId from juggle_list_conversations).'),
        limit: limitInput(50, 200, 'most recent messages'),
        offset: offsetInput('newest messages (to page back in time)'),
        view: viewInput('compact: id, from, mine, sentAt, type, text. "full" returns the upstream message items; "raw" the same, indented.'),
      }),
    },
    async ({ conversation_id, limit, offset, view }) => {
      const route = `/messages/${conversation_id}`;
      const page = await client.getPage(route);
      const data = rec(page.data);
      const all = requireList(data, 'messages', route);
      const end = Math.max(0, all.length - (offset ?? 0));
      const slice = all.slice(Math.max(0, end - (limit ?? 50)), end);
      const head = {
        conversationId: num(data.conversationId) ?? conversation_id,
        isActive: flag(data.isActive),
        total: all.length,
        offsetFromNewest: offset ?? 0,
        returned: slice.length,
      };
      return respond(view, { ...head, messages: slice }, {
        context: `GET ${route}`,
        project: () => ({ ...head, messages: slice.map(compactMessage) }),
        untrustedNote: UNTRUSTED_NOTES.messages,
      });
    },
  );
}
