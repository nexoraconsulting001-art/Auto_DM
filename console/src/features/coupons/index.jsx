import { lazy } from 'react';
import { TicketPercent } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const CouponsPage = lazy(() => import('./CouponsPage.jsx'));
const CouponFormPage = lazy(() => import('./CouponFormPage.jsx'));

/** Discount codes for reels and stories, and which of them worked (9.14). */
export default {
  name: 'coupons',
  access: MANAGERS,
  nav: { to: '/coupons', label: 'Coupons', icon: TicketPercent, order: 25 },
  routes: [
    { path: 'coupons', element: <CouponsPage /> },
    { path: 'coupons/new', element: <CouponFormPage /> },
    { path: 'coupons/:id', element: <CouponFormPage /> },
  ],
};
