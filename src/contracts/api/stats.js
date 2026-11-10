import { z } from 'zod';
import { staffWith } from './access.js';
import { Count, Paise } from './common.js';

export const DashboardStats = z.object({
  dms: Count,
  dmsToday: Count,
  visits: Count,
  visitsToday: Count,
  orders: Count,
  ordersToday: Count,
  revenuePaise: Paise,
  toConfirm: Count,
  toShip: Count,
  products: Count,
});

export const statRoutes = {
  'stats.dashboard': { method: 'GET', path: '/stats/dashboard', access: staffWith('analytics'), response: DashboardStats },
};
