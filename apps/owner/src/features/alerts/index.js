import Bell from 'lucide-react-native/icons/bell-ring';
import { staffWith } from '@bhava/app-core/access';
import AlertsScreen from './AlertsScreen.js';

/**
 * Alerts: what the platform noticed about this business, read and marked read. The access is the API's own
 * (alerts.list is staff with the automations permission), so nobody is shown a screen the server would refuse.
 */
export default {
  name: 'alerts',
  access: staffWith('automations'),
  feature: null,
  routeIds: ['alerts.list', 'alerts.markRead'],
  screens: [{ name: 'index', path: 'alerts', title: 'alerts.title', component: AlertsScreen }],
  nav: { label: 'alerts.title', order: 61, icon: Bell },
  strings: {
    en: {
      'alerts.title': 'Alerts',
      'alerts.intro': 'What we noticed about your account, newest first.',
      'alerts.empty': 'No alerts',
      'alerts.emptyBody': 'If something needs you, such as a lost connection or a link that stopped working, it shows up here.',
      'alerts.new': 'New',
      'alerts.open': 'Open',
      'alerts.markRead': 'Mark as read',
      'alerts.severity.info': 'Info',
      'alerts.severity.warning': 'Warning',
      'alerts.severity.critical': 'Urgent',
    },
    hi: {
      'alerts.title': 'अलर्ट',
      'alerts.intro': 'आपके अकाउंट के बारे में हमने जो देखा, सबसे नया पहले।',
      'alerts.empty': 'कोई अलर्ट नहीं',
      'alerts.emptyBody': 'अगर किसी चीज़ पर आपकी ज़रूरत हो, जैसे टूटा कनेक्शन या काम करना बंद कर चुका लिंक, तो वह यहाँ दिखेगी।',
      'alerts.new': 'नया',
      'alerts.open': 'खोलें',
      'alerts.markRead': 'पढ़ा हुआ मानें',
      'alerts.severity.info': 'जानकारी',
      'alerts.severity.warning': 'चेतावनी',
      'alerts.severity.critical': 'ज़रूरी',
    },
  },
};
