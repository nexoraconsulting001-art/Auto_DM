/**
 * The owner app's words: the shared lines from @bhava/app-core, the shell's own below, and each feature's (its
 * `strings` in features/<name>/index.js). Everything a seller reads here is the platform's own brand; a business's
 * name appears only as the workspace it is working in.
 */
import { sharedStrings } from '@bhava/app-core';
import { features } from './features/index.js';

export const APP_NAME = 'Bhava for Business';

const shell = {
  en: {
    'signIn.title': 'Sign in to {app}',
    'signIn.subtitle': 'Run your Instagram shop from your phone.',
    'signIn.whatsapp': 'Continue with WhatsApp',
    'signIn.google': 'Continue with Google',
    'signIn.apple': 'Continue with Apple',
    'signIn.phone': 'WhatsApp number',
    'signIn.phoneHint': 'We’ll send a 6-digit code on WhatsApp.',
    'signIn.sendCode': 'Send code',
    'signIn.code': 'Code from WhatsApp',
    'signIn.verify': 'Sign in',
    'signIn.noCode': 'Didn’t get it? Try another way to sign in.',
    'signIn.back': 'Use a different number',
    'signIn.failed': 'That didn’t work. Check it and try again.',
    'signIn.cancelled': 'Sign-in was cancelled.',
    'signIn.network': 'We couldn’t reach the server. Check your connection and try again.',
    'signIn.notConfigured': 'This build has no server address, so it can’t sign in.',
    'more.title': 'More',
    'switcher.title': 'Your businesses',
    'switcher.current': 'Current',
    'switcher.failed': 'We couldn’t switch. Check your connection and try again.',
    'pending.body': 'This screen is on its way.',
    'tabs.more': 'More',
  },
  hi: {
    'signIn.title': '{app} में साइन इन करें',
    'signIn.subtitle': 'अपनी Instagram दुकान अपने फ़ोन से चलाएँ।',
    'signIn.whatsapp': 'WhatsApp से जारी रखें',
    'signIn.google': 'Google से जारी रखें',
    'signIn.apple': 'Apple से जारी रखें',
    'signIn.phone': 'WhatsApp नंबर',
    'signIn.phoneHint': 'हम WhatsApp पर 6 अंकों का कोड भेजेंगे।',
    'signIn.sendCode': 'कोड भेजें',
    'signIn.code': 'WhatsApp पर आया कोड',
    'signIn.verify': 'साइन इन करें',
    'signIn.noCode': 'कोड नहीं मिला? साइन इन का कोई और तरीका आज़माएँ।',
    'signIn.back': 'दूसरा नंबर इस्तेमाल करें',
    'signIn.failed': 'यह काम नहीं किया। जाँचकर फिर कोशिश करें।',
    'signIn.cancelled': 'साइन इन रद्द कर दिया गया।',
    'signIn.network': 'हम सर्वर तक नहीं पहुँच सके। अपना कनेक्शन जाँचें और फिर कोशिश करें।',
    'signIn.notConfigured': 'इस बिल्ड में सर्वर का पता नहीं है, इसलिए साइन इन नहीं हो सकता।',
    'more.title': 'और',
    'switcher.title': 'आपके बिज़नेस',
    'switcher.current': 'अभी चालू',
    'switcher.failed': 'हम बदल नहीं सके। अपना कनेक्शन जाँचें और फिर कोशिश करें।',
    'pending.body': 'यह स्क्रीन जल्द आ रही है।',
    'tabs.more': 'और',
  },
};

const merge = (locale) => Object.assign({}, sharedStrings[locale], shell[locale], ...features.map((feature) => feature.strings?.[locale] ?? {}));

export const catalogue = Object.freeze({ en: Object.freeze(merge('en')), hi: Object.freeze(merge('hi')) });
