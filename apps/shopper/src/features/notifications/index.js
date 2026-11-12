import NotificationsScreen from './NotificationsScreen.js';

/**
 * The three notification choices, each with its own opt-in: order updates, offers, new reels (P-62).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'notifications',
  screens: [
    { name: 'index', path: 'account/notifications', title: 'notifications.title', component: NotificationsScreen },
  ],
  nav: null,
  strings: { en: { 'notifications.title': 'Notifications' }, hi: { 'notifications.title': 'सूचनाएँ' } },
};
