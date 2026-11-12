import NotificationsScreen from './NotificationsScreen.js';
import { createNotifier } from './flow.js';

/**
 * The three notification choices, each with its own opt-in: order updates, offers, new reels (P-62). The service is the
 * notifier (`services.notifications`); the system prompt is asked only after the first order, through the explainer.
 */
function deviceFlag(services) {
  const prefix = `shopper.t${services.config.brand.tenantId}`;
  const options = () => {
    try {
      return { keychainAccessible: require('expo-secure-store').WHEN_UNLOCKED_THIS_DEVICE_ONLY };
    } catch {
      return undefined;
    }
  };
  return {
    get: async (name) => {
      try {
        return await require('expo-secure-store').getItemAsync(`${prefix}.${name}`, options());
      } catch {
        return null;
      }
    },
    set: async (name, value) => {
      try {
        await require('expo-secure-store').setItemAsync(`${prefix}.${name}`, String(value), options());
      } catch {
        // A flag that cannot be kept only means the explainer may be offered once more.
      }
    },
  };
}

export default {
  name: 'notifications',
  screens: [
    { name: 'index', path: 'account/notifications', title: 'notifications.title', component: NotificationsScreen },
  ],
  nav: null,
  service(services) {
    let notifications = services.pushModule;
    if (!notifications) {
      try {
        notifications = require('expo-notifications');
      } catch {
        notifications = null;
      }
    }
    return createNotifier({ client: services.client, notifications: notifications ?? { getPermissionsAsync: async () => ({ granted: false, canAskAgain: false, status: 'denied' }) }, flag: services.notificationFlag ?? deviceFlag(services) });
  },
  strings: {
    en: {
      'notifications.title': 'Notifications',
      'notifications.order': 'Order updates',
      'notifications.orderSub': 'When your order is packed, shipped and delivered.',
      'notifications.offers': 'Offers',
      'notifications.offersSub': 'Sales and coupons. Off until you turn it on.',
      'notifications.reels': 'New reels',
      'notifications.reelsSub': 'When {brand} adds a reel. Off until you turn it on.',
      'notifications.denied': 'Notifications are turned off for this app in your phone’s settings. The app works the same without them.',
      'notifications.settings': 'Open settings',
      'notifications.explainTitle': 'Hear about your order?',
      'notifications.explainBody': 'Allow notifications and {brand} tells you when your order is packed, shipped and delivered. We will not send offers or reel news unless you turn them on in Account.',
      'notifications.turnOn': 'Turn on order updates',
      'notifications.notNow': 'Not now',
    },
    hi: {
      'notifications.title': 'सूचनाएँ',
      'notifications.order': 'ऑर्डर की जानकारी',
      'notifications.orderSub': 'जब आपका ऑर्डर पैक, रवाना और डिलीवर हो।',
      'notifications.offers': 'ऑफ़र',
      'notifications.offersSub': 'सेल और कूपन। आप चालू करेंगे तभी।',
      'notifications.reels': 'नई रील',
      'notifications.reelsSub': 'जब {brand} नई रील जोड़े। आप चालू करेंगे तभी।',
      'notifications.denied': 'आपके फ़ोन की सेटिंग में इस ऐप की सूचनाएँ बंद हैं। सूचनाओं के बिना भी ऐप पूरी तरह चलता है।',
      'notifications.settings': 'सेटिंग खोलें',
      'notifications.explainTitle': 'ऑर्डर की ख़बर चाहिए?',
      'notifications.explainBody': 'सूचनाएँ चालू करें तो {brand} आपको बताएगा कि ऑर्डर कब पैक, रवाना और डिलीवर हुआ। आप खाते में चालू नहीं करेंगे तो हम ऑफ़र या रील की ख़बर नहीं भेजेंगे।',
      'notifications.turnOn': 'ऑर्डर की जानकारी चालू करें',
      'notifications.notNow': 'अभी नहीं',
    },
  },
};
