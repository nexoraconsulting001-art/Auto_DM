import { z } from 'zod';
import { MANAGERS, staffWith } from './access.js';
import { Id, ListQuery, Timestamp, page, text } from './common.js';

export const CONNECTION_STATUSES = Object.freeze(['not_connected', 'active', 'reconnect_needed', 'deauthorized']);

/** A page of the console to come back to after connecting, never a full address. */
export const ReturnTo = text(200).regex(/^\/(?!\/)/, 'Use a page of this site');
export const ConnectStart = z.object({ returnTo: ReturnTo.optional() });
export const ConnectLink = z.object({ authorizeUrl: z.string() });

/** The business's Instagram connection. health is amber at 14 days or less or after a failed refresh, red at 3 days or less (PRD 4.2). */
export const IgConnection = z.object({
  status: z.enum(CONNECTION_STATUSES),
  igUserId: z.string().nullable(),
  username: z.string(),
  loginKind: z.enum(['instagram', 'unified']).nullable(),
  scopes: z.array(z.string()),
  missingScopes: z.array(z.string()),
  insightsGranted: z.boolean(),
  tokenExpiresAt: Timestamp.nullable(),
  health: z.enum(['none', 'ok', 'amber', 'red']),
  webhooksSubscribed: z.boolean(),
});

export const IgMediaQuery = ListQuery.extend({ type: z.enum(['all', 'reel', 'post', 'story']).default('all') });

/** One tile of the builder's grid (PRD 6.8). automationId is set when the media already has an active automation. */
export const IgMediaItem = z.object({
  id: z.string(),
  type: z.enum(['reel', 'post', 'story']),
  caption: z.string(),
  permalink: z.string(),
  thumbnailUrl: z.string(),
  postedAt: Timestamp.nullable(),
  automationId: Id.nullable(),
});

export const instagramRoutes = {
  'instagram.connection': { method: 'GET', path: '/instagram/connection', access: staffWith('automations'), response: IgConnection },
  'instagram.connect': { method: 'POST', path: '/instagram/connect', access: MANAGERS, body: ConnectStart, response: ConnectLink },
  'instagram.disconnect': { method: 'DELETE', path: '/instagram/connection', access: MANAGERS, status: 204, response: null },
  'instagram.media': { method: 'GET', path: '/instagram/media', access: staffWith('automations'), query: IgMediaQuery, response: page(IgMediaItem) },
};
