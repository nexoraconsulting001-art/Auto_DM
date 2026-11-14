import { lazy } from 'react';
import { MessageSquareText } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const WhatsappPage = lazy(() => import('./WhatsappPage.jsx'));

/** WhatsApp (PRD 6.12): connect the business's own number, keyword replies and who has opted in. */
export default {
  name: 'whatsapp',
  access: MANAGERS,
  nav: { to: '/whatsapp', label: 'WhatsApp', icon: MessageSquareText, order: 65 },
  routes: [{ path: 'whatsapp', element: <WhatsappPage /> }],
};
