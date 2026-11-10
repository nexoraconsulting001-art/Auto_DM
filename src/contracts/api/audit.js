import { z } from 'zod';
import { OWNER_ONLY } from './access.js';
import { ListQuery, Timestamp, page } from './common.js';

/** One human or admin action on this business. Never a secret: keys are masked before they get here. */
export const AuditEntry = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});

export const auditRoutes = {
  'audit.list': { method: 'GET', path: '/audit-log', access: OWNER_ONLY, query: ListQuery, response: page(AuditEntry) },
};
