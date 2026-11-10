import { z } from 'zod';
import { MANAGERS, staffWith } from './access.js';
import { ListQuery, Timestamp, page, required } from './common.js';
import { CONNECTION_STATUSES, ConnectLink, ConnectStart } from './instagram.js';

const access = staffWith('automations');

/** A Facebook post id, such as 123_456. */
export const FbPostParams = z.object({ id: z.string().regex(/^[\w-]{1,80}$/) });

/** enabled is false until Facebook Pages is switched on, and the console then shows nothing at all (PRD 6.10). */
export const FbConnection = z.object({ enabled: z.boolean(), status: z.enum(CONNECTION_STATUSES), pageId: z.string().nullable(), pageName: z.string(), tokenExpiresAt: Timestamp.nullable() });
export const FbPost = z.object({ id: z.string(), message: z.string(), permalink: z.string(), postedAt: Timestamp.nullable(), linkedIgMediaId: z.string().nullable() });
export const FbPostLink = z.object({ fbPostId: z.string(), igMediaId: z.string(), status: z.enum(['suggested', 'confirmed', 'rejected']), confirmedAt: Timestamp.nullable() });
export const FbLinkSuggestion = z.object({ fbPostId: z.string(), igMediaId: z.string(), score: z.number().min(0).max(1) });
export const FbLinkSuggestions = z.object({ items: z.array(FbLinkSuggestion) });
export const FbLinkSave = z.object({ igMediaId: required(80) });

export const facebookRoutes = {
  'facebook.connection': { method: 'GET', path: '/facebook/connection', access, response: FbConnection },
  'facebook.connect': { method: 'POST', path: '/facebook/connect', access: MANAGERS, body: ConnectStart, response: ConnectLink },
  'facebook.disconnect': { method: 'DELETE', path: '/facebook/connection', access: MANAGERS, status: 204, response: null },
  'facebook.posts': { method: 'GET', path: '/facebook/posts', access, query: ListQuery, response: page(FbPost) },
  'facebook.links': { method: 'GET', path: '/facebook/links', access, query: ListQuery, response: page(FbPostLink) },
  'facebook.suggestions': { method: 'GET', path: '/facebook/link-suggestions', access, response: FbLinkSuggestions },
  'facebook.saveLink': { method: 'PUT', path: '/facebook/links/:id', access, params: FbPostParams, body: FbLinkSave, response: FbPostLink },
  'facebook.removeLink': { method: 'DELETE', path: '/facebook/links/:id', access, params: FbPostParams, status: 204, response: null },
};
