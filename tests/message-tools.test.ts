import { describe, expect, it } from 'vitest';
import { conversationData, conversationsData } from './fixtures.js';
import { callTool, makeClient, siteWith } from './tool-harness.js';

type Rec = Record<string, unknown>;

describe('juggle_list_conversations', () => {
  const site = () => siteWith({ '/messages': ['Messages', conversationsData] });

  it('lists conversations compactly, framed as untrusted', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_conversations');
    expect(r.json).toMatchObject({ untrusted_content: true, total: 2, returned: 2 });
    expect((r.json.conversations as Rec[])[0]).toEqual({
      conversationId: 4001,
      name: 'Test Sitter',
      lastMessage: 'See you Friday!',
      lastMessageAt: '2026-11-01 09:00:00',
      unread: 1,
    });
  });

  it('unread_only keeps conversations with unread messages', async () => {
    const r = await callTool(makeClient(site()), 'juggle_list_conversations', { unread_only: true });
    expect((r.json.conversations as Rec[]).map((c) => c.conversationId)).toEqual([4001]);
  });

  it('never uses /web-api/conversations (401 for web sessions)', async () => {
    const s = site();
    await callTool(makeClient(s), 'juggle_list_conversations');
    expect(s.requests.some((q) => q.path.startsWith('/web-api'))).toBe(false);
  });
});

describe('juggle_get_conversation', () => {
  it('returns the most recent messages, oldest first, with paragraphs intact', async () => {
    const s = siteWith({ '/messages/4001': ['Conversation', conversationData(5)] });
    const r = await callTool(makeClient(s), 'juggle_get_conversation', { conversation_id: 4001, limit: 2 });
    expect(r.json).toMatchObject({ untrusted_content: true, conversationId: 4001, isActive: true, total: 5, returned: 2 });
    expect(r.json.messages).toEqual([
      { id: 6003, from: 'Test Parent', mine: true, sentAt: '2026-11-01 03:00:00', type: 'text', content: 'Message 4\n\nsecond paragraph' },
      { id: 6004, from: 'Test Sitter', mine: false, sentAt: '2026-11-01 04:00:00', type: 'text', content: 'Message 5\n\nsecond paragraph' },
    ]);
  });

  it('pages backwards with offset (counted from the newest)', async () => {
    const s = siteWith({ '/messages/4001': ['Conversation', conversationData(5)] });
    const r = await callTool(makeClient(s), 'juggle_get_conversation', { conversation_id: 4001, limit: 2, offset: 2 });
    expect((r.json.messages as Rec[]).map((m) => m.id)).toEqual([6001, 6002]);
    const end = await callTool(makeClient(s), 'juggle_get_conversation', { conversation_id: 4001, limit: 2, offset: 4 });
    expect((end.json.messages as Rec[]).map((m) => m.id)).toEqual([6000]);
  });

  it('a missing conversation is an error, not an empty thread', async () => {
    const r = await callTool(makeClient(siteWith({})), 'juggle_get_conversation', { conversation_id: 1 });
    expect(r.isError).toBe(true);
  });
});
