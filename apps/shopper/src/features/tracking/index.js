import TrackingScreen from './TrackingScreen.js';

/**
 * Where a parcel is, on the seller’s own tracking page data.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'tracking',
  screens: [
    { name: 'index', path: 'track/:token', title: 'tracking.title', component: TrackingScreen, link: true },
  ],
  nav: null,
  strings: { en: { 'tracking.title': 'Track order' }, hi: { 'tracking.title': 'ऑर्डर ट्रैक करें' } },
};
