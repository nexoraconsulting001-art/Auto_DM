import { lazy } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const AiRepliesPage = lazy(() => import('./AiRepliesPage.jsx'));

/** FAQ and AI replies (PRD 6.11): the answers the add-on uses, its switch and confidence, a test question, and its log. */
export default {
  name: 'ai-replies',
  access: staffWith('automations'),
  nav: { to: '/ai-replies', label: 'FAQ and AI replies', icon: MessageCircleQuestion, order: 64 },
  routes: [{ path: 'ai-replies', element: <AiRepliesPage /> }],
};
