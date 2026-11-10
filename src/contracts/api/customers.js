import { z } from 'zod';
import { MANAGERS, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, Timestamp, page, text } from './common.js';

export const Customer = z.object({
  id: Id,
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'manager', 'staff', 'customer']),
  orderCount: Count,
  spentPaise: Paise,
  createdAt: Timestamp,
});
export const CustomerListQuery = ListQuery.extend({ search: text(80).optional() });

/** Shown once, for the seller to pass on. Applies to shoppers only and ends the shopper's sessions. */
export const PasswordReset = z.object({ temporaryPassword: z.string() });

export const customerRoutes = {
  'customers.list': { method: 'GET', path: '/customers', access: staffWith('customers'), query: CustomerListQuery, response: page(Customer) },
  'customers.resetPassword': { method: 'POST', path: '/customers/:id/reset-password', access: MANAGERS, params: IdParams, response: PasswordReset },
};
