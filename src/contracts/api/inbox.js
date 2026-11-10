import { z } from 'zod';
import { Channel } from '../compliance.js';
import { staffWith } from './access.js';
import { Id, IdParams, ListQuery, Timestamp, page, required } from './common.js';
import { ReasonCode } from './compliance.js';

const access = staffWith('inbox');

export const THREAD_STATUSES = Object.freeze(['open', 'needs_human', 'closed']);
export const NEEDS_HUMAN_KINDS = Object.freeze(['negative_comment', 'handoff', 'send_failed', 'unknown_outcome', 'why_no_dm']);

/** canReply is false once the last message is 23h50m old, and the composer then says "Reply in the Instagram app" (PRD 6.7). */
export const InboxThread = z.object({
  id: Id,
  channel: Channel,
  username: z.string(),
  lastMessage: z.string(),
  lastMessageAt: Timestamp.nullable(),
  lastUserMessageAt: Timestamp.nullable(),
  status: z.enum(THREAD_STATUSES),
  automationPausedUntil: Timestamp.nullable(),
  pauseReason: ReasonCode,
  canReply: z.boolean(),
});

export const InboxMessage = z.object({
  id: z.number().int().positive(),
  direction: z.enum(['in', 'out']),
  author: z.enum(['person', 'automation', 'owner']),
  kind: z.enum(['text', 'story_reply', 'story_mention', 'postback', 'attachment']),
  text: z.string(),
  mediaRef: z.string(),
  at: Timestamp,
});
export const InboxThreadDetail = InboxThread.extend({ messages: z.array(InboxMessage) });

export const InboxThreadsQuery = ListQuery.extend({ status: z.enum(THREAD_STATUSES).optional() });
export const InboxReply = z.object({ text: required(4000, 'Write a reply') });
export const InboxReplyResult = z.object({ outcome: z.string(), reason: ReasonCode, automationPausedUntil: Timestamp.nullable() });

export const NeedsHumanItem = z.object({
  id: Id,
  channel: Channel,
  kind: z.enum(NEEDS_HUMAN_KINDS),
  reason: ReasonCode,
  threadId: Id.nullable(),
  commentId: z.string(),
  mediaId: z.string(),
  username: z.string(),
  text: z.string(),
  status: z.enum(['open', 'resolved']),
  createdAt: Timestamp,
});
export const NeedsHumanQuery = ListQuery.extend({ status: z.enum(['open', 'resolved']).default('open') });

export const inboxRoutes = {
  'inbox.threads': { method: 'GET', path: '/inbox/threads', access, query: InboxThreadsQuery, response: page(InboxThread) },
  'inbox.thread': { method: 'GET', path: '/inbox/threads/:id', access, params: IdParams, response: InboxThreadDetail },
  'inbox.reply': { method: 'POST', path: '/inbox/threads/:id/reply', access, params: IdParams, body: InboxReply, response: InboxReplyResult },
  'inbox.needsHuman': { method: 'GET', path: '/inbox/needs-human', access, query: NeedsHumanQuery, response: page(NeedsHumanItem) },
  'inbox.resolve': { method: 'POST', path: '/inbox/needs-human/:id/resolve', access, params: IdParams, response: NeedsHumanItem },
};
