import Smartphone from 'lucide-react-native/icons/smartphone';
import { SIGNED_IN } from '@bhava/app-core/access';
import DevicesScreen from './DevicesScreen.js';

/**
 * Settings > Devices (PRD 10.2, P-08): every phone and browser signed in to this person's account, and the way to sign
 * one out everywhere at once. Each person sees only their own devices; nobody's role changes that. The path is the
 * one the server's "New sign-in" notice links to.
 */
export default {
  name: 'devices',
  access: SIGNED_IN,
  feature: null,
  routeIds: ['auth.devices', 'auth.revokeDevice', 'console:/settings/devices'],
  screens: [{ name: 'index', path: 'settings/devices', title: 'devices.title', component: DevicesScreen }],
  nav: { label: 'devices.title', order: 77, icon: Smartphone },
  strings: {
    en: {
      'devices.title': 'Devices',
      'devices.intro': 'Phones and computers signed in to your account. Sign out any you don’t recognise: it stops working within a minute.',
      'devices.thisPhone': 'This phone',
      'devices.unlockOn': 'Fingerprint or face unlock on',
      'devices.lastSeen': 'Last used {when}',
      'devices.platform.android': 'Android',
      'devices.platform.ios': 'iPhone',
      'devices.platform.web': 'Web browser',
      'devices.app.owner': 'App {version}',
      'devices.app.shopper': 'Shop app {version}',
      'devices.unnamed': 'Unnamed device',
      'devices.signOut': 'Sign out',
      'devices.signOutLabel': 'Sign out {name}',
      'devices.confirm.title': 'Sign out {name}?',
      'devices.confirm.body': 'It will be signed out everywhere it’s open, within a minute. Signing in there again needs a new code or Google.',
      'devices.confirm.thisPhone': 'This is the phone you’re using. You’ll be signed out here now.',
      'devices.confirm.action': 'Sign it out',
      'devices.empty': 'No devices are signed in.',
      'devices.failed': 'That device wasn’t signed out. Try again.',
    },
    hi: {
      'devices.title': 'डिवाइस',
      'devices.intro': 'आपके अकाउंट में साइन इन फ़ोन और कंप्यूटर। जिन्हें आप नहीं पहचानते, उन्हें साइन आउट करें: वे एक मिनट के अंदर काम करना बंद कर देंगे।',
      'devices.thisPhone': 'यह फ़ोन',
      'devices.unlockOn': 'फ़िंगरप्रिंट या फ़ेस अनलॉक चालू',
      'devices.lastSeen': 'आख़िरी बार {when}',
      'devices.platform.android': 'Android',
      'devices.platform.ios': 'iPhone',
      'devices.platform.web': 'वेब ब्राउज़र',
      'devices.app.owner': 'ऐप {version}',
      'devices.app.shopper': 'शॉप ऐप {version}',
      'devices.unnamed': 'बिना नाम का डिवाइस',
      'devices.signOut': 'साइन आउट',
      'devices.signOutLabel': '{name} को साइन आउट करें',
      'devices.confirm.title': '{name} को साइन आउट करें?',
      'devices.confirm.body': 'यह जहाँ भी खुला है, एक मिनट के अंदर साइन आउट हो जाएगा। वहाँ फिर साइन इन करने के लिए नया कोड या Google चाहिए होगा।',
      'devices.confirm.thisPhone': 'यह वही फ़ोन है जिसे आप इस्तेमाल कर रहे हैं। आप यहाँ अभी साइन आउट हो जाएँगे।',
      'devices.confirm.action': 'साइन आउट करें',
      'devices.empty': 'कोई डिवाइस साइन इन नहीं है।',
      'devices.failed': 'वह डिवाइस साइन आउट नहीं हुआ। फिर कोशिश करें।',
    },
  },
};
