import History from 'lucide-react-native/icons/history';
import { OWNER_ONLY } from '@bhava/app-core/access';
import AuditLogScreen from './AuditLogScreen.js';

/** The audit log (PRD 5.11): every change in this business, by whom and when. Owner only. */
export default {
  name: 'audit-log',
  access: OWNER_ONLY,
  feature: null,
  routeIds: ['audit.list', 'console:/audit-log'],
  screens: [{ name: 'index', path: 'audit-log', title: 'audit-log.title', component: AuditLogScreen }],
  nav: { label: 'audit-log.title', order: 90, icon: History },
  strings: {
    en: {
      'audit-log.title': 'Audit log',
      'audit-log.intro': 'Every change made in this business, newest first.',
      'audit-log.empty': 'Nothing yet.',
      'audit-log.by': 'by {actor}',
    },
    hi: {
      'audit-log.title': 'ऑडिट लॉग',
      'audit-log.intro': 'इस बिज़नेस में किया गया हर बदलाव, सबसे नया पहले।',
      'audit-log.empty': 'अभी कुछ नहीं।',
      'audit-log.by': '{actor} ने',
    },
  },
};
