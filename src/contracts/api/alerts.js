import { z } from 'zod';
import { staffWith } from './access.js';
import { IdText, ListQuery, Timestamp, page } from './common.js';

const access = staffWith('automations');

export const AlertParams = z.object({ id: IdText });
export const OwnerAlert = z.object({
  id: z.number().int().positive(),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  target: z.string(),
  createdAt: Timestamp,
  readAt: Timestamp.nullable(),
});

export const alertRoutes = {
  'alerts.list': { method: 'GET', path: '/alerts', access, query: ListQuery, response: page(OwnerAlert) },
  'alerts.markRead': { method: 'POST', path: '/alerts/:id/read', access, params: AlertParams, status: 204, response: null },
};
