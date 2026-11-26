import { createSecureStore } from '@bhava/app-core/storage';
import NotificationsScreen from './NotificationsScreen.js';
import { createNotifier } from './flow.js';

/**
 * The three notification choices, each with its own opt-in: order updates, offers, new reels (P-62). The service is the
 * notifier (`services.notifications`); the system prompt is asked only after the first order, through the explainer.
 */
function deviceFlag(services) {
  // The same store, and so the same keys, as the sign-in (features/sign-in): @bhava/app-core's storage is the one place
  // that touches SecureStore.
  const store = services.secureStore ?? createSecureStore({ prefix: `shopper.t${services.config.brand.tenantId}` });
  return {
    get: async (name) => {
      try {
        return await store.getDeviceFlag(name);
      } catch {
        return null;
      }
    },
    set: async (name, value) => {
      try {
        await store.setDeviceFlag(name, value);
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
