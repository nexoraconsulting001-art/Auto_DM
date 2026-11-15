import { MessageSquareText } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const FeedbackPage = screen(load, 'FeedbackPage');

/** Showcase feedback (Phase 8, Q-13): what a business said in a session and what became of it. Bhava's team only. */
export default {
  name: 'feedback',
  roles: ['super_admin', 'support'],
  nav: { to: '/feedback', label: 'Feedback', icon: MessageSquareText, order: 95 },
  routes: [
    { path: 'feedback', element: <FeedbackPage /> },
  ],
};
