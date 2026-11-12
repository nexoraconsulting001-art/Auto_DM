import TrackingScreen from './TrackingScreen.js';

/** Where a parcel is, from the order's own status and the courier's scans. */
export default {
  name: 'tracking',
  screens: [
    { name: 'index', path: 'track/:token', title: 'tracking.title', component: TrackingScreen, link: true },
  ],
  nav: null,
  strings: {
    en: {
      'tracking.title': 'Track order',
      'tracking.step.placed': 'Order placed',
      'tracking.step.packed': 'Packed',
      'tracking.step.shipped': 'Shipped',
      'tracking.step.out_for_delivery': 'Out for delivery',
      'tracking.step.delivered': 'Delivered',
      'tracking.now': 'Now',
      'tracking.done': 'Done',
      'tracking.parcel': 'Parcel with {courier}',
      'tracking.expected': 'Expected {date}',
      'tracking.courierPage': 'Open the courier’s page',
      'tracking.signInHint': 'Sign in to see the courier and every scan.',
      'tracking.back': 'Back',
    },
    hi: {
      'tracking.title': 'ऑर्डर ट्रैक करें',
      'tracking.step.placed': 'ऑर्डर मिला',
      'tracking.step.packed': 'पैक हुआ',
      'tracking.step.shipped': 'भेजा गया',
      'tracking.step.out_for_delivery': 'डिलीवरी के लिए निकला',
      'tracking.step.delivered': 'पहुँच गया',
      'tracking.now': 'अभी',
      'tracking.done': 'हो गया',
      'tracking.parcel': '{courier} के साथ पार्सल',
      'tracking.expected': 'अनुमानित {date}',
      'tracking.courierPage': 'कूरियर का पेज खोलें',
      'tracking.signInHint': 'कूरियर और हर स्कैन देखने के लिए साइन इन करें।',
      'tracking.back': 'वापस',
    },
  },
};
