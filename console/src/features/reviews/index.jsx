import { lazy } from 'react';
import { Star } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const ReviewsPage = lazy(() => import('./ReviewsPage.jsx'));
const SavesPage = lazy(() => import('./SavesPage.jsx'));

/** Ratings and reviews to approve, hide and answer (9.19), and how many shoppers saved each product (9.20). */
export default {
  name: 'reviews',
  access: staffWith('catalog'),
  nav: { to: '/reviews', label: 'Reviews', icon: Star, order: 26 },
  routes: [
    { path: 'reviews', element: <ReviewsPage /> },
    { path: 'reviews/saves', element: <SavesPage /> },
  ],
};
