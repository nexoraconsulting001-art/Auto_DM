import Bell from 'lucide-react-native/icons/bell';
import { SIGNED_IN } from '@bhava/app-core/access';
import NotificationSettingsScreen from './NotificationSettingsScreen.js';
import NotificationsScreen from './NotificationsScreen.js';

/**
 * What Bhava tells this person (PRD 5.13, 10.5): the in-app list behind the bell, and the choices per kind and
 * channel with quiet hours. Each person's own list and choices in the business in use; nobody else's.
 */
export default {
  name: 'notifications',
  access: SIGNED_IN,
  feature: null,
  routeIds: ['notifications.list', 'notifications.markRead', 'notifications.prefs', 'notifications.savePrefs', 'console:/notifications', 'console:/notifications/settings'],
  screens: [
    { name: 'index', path: 'notifications', title: 'notifications.title', component: NotificationsScreen },
    { name: 'settings', path: 'notifications/settings', title: 'notifications.settings', component: NotificationSettingsScreen },
  ],
  nav: { label: 'notifications.title', order: 62, icon: Bell },
  strings: {
    en: {
      'notifications.title': 'Notifications',
      'notifications.settings': 'Notification settings',
      'notifications.openSettings': 'Choose what you hear about',
      'notifications.unread': '{count} unread',
      'notifications.markAll': 'Mark all as read',
      'notifications.unreadLabel': 'Unread: {title}',
      'notifications.empty': 'Nothing new',
      'notifications.emptyBody': 'Orders, alerts and reports for this business show up here.',
      'notifications.more': 'Show older',
      'notifications.channel.push': 'Push on this phone',
      'notifications.channel.email': 'Email',
      'notifications.channel.whatsapp': 'WhatsApp',
      'notifications.inapp': 'Always shown here in the app.',
      'notifications.mandatory': 'A security notice: it can’t be turned off.',
      'notifications.unavailable': 'Not set up yet.',
      'notifications.critical': 'Urgent: never held for quiet hours.',
      'notifications.quiet': 'Quiet hours',
      'notifications.quietBody': 'Push and WhatsApp wait until quiet hours end. Urgent alerts still come through.',
      'notifications.quietFrom': 'From',
      'notifications.quietTo': 'To',
      'notifications.quietSave': 'Save quiet hours',
      'notifications.badTime': 'Use a time such as 22:00.',
      'notifications.saved': 'Saved.',
    },
    hi: {
      'notifications.title': 'नोटिफ़िकेशन',
      'notifications.settings': 'नोटिफ़िकेशन सेटिंग',
      'notifications.openSettings': 'चुनें कि आपको किन बातों की ख़बर मिले',
      'notifications.unread': '{count} बिना पढ़े',
      'notifications.markAll': 'सब पढ़ा हुआ मार्क करें',
      'notifications.unreadLabel': 'बिना पढ़ा: {title}',
      'notifications.empty': 'कुछ नया नहीं',
      'notifications.emptyBody': 'इस बिज़नेस के ऑर्डर, अलर्ट और रिपोर्ट यहाँ दिखते हैं।',
      'notifications.more': 'पुराने दिखाएँ',
      'notifications.channel.push': 'इस फ़ोन पर पुश',
      'notifications.channel.email': 'ईमेल',
      'notifications.channel.whatsapp': 'WhatsApp',
      'notifications.inapp': 'ऐप में यहाँ हमेशा दिखता है।',
      'notifications.mandatory': 'सुरक्षा सूचना: इसे बंद नहीं किया जा सकता।',
      'notifications.unavailable': 'अभी सेट अप नहीं है।',
      'notifications.critical': 'ज़रूरी: शांत समय में भी नहीं रुकता।',
      'notifications.quiet': 'शांत समय',
      'notifications.quietBody': 'शांत समय ख़त्म होने तक पुश और WhatsApp रुके रहते हैं। ज़रूरी अलर्ट फिर भी आते हैं।',
      'notifications.quietFrom': 'से',
      'notifications.quietTo': 'तक',
      'notifications.quietSave': 'शांत समय सेव करें',
      'notifications.badTime': '22:00 जैसा समय डालें।',
      'notifications.saved': 'सेव हो गया।',
    },
  },
};
