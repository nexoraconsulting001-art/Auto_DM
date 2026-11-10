import { z } from 'zod';
import { staffWith } from './access.js';
import { Id, ListQuery, Timestamp, page } from './common.js';

/** One comment and what happened to it. Shown to the seller on screen; these fields must never reach a log. */
export const ActivityItem = z.object({
  id: Id,
  commentId: z.string().nullable(),
  reelId: z.string().nullable(),
  reelHeadline: z.string().nullable(),
  reelSlug: z.string().nullable(),
  username: z.string(),
  text: z.string(),
  result: z.string(),
  error: z.string(),
  createdAt: Timestamp,
});

export const activityRoutes = {
  'activity.list': { method: 'GET', path: '/activity', access: staffWith('automations'), query: ListQuery, response: page(ActivityItem) },
};
