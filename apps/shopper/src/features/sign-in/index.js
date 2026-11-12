import SignInScreen from './SignInScreen.js';
import { createSession } from './session.js';
import { createSecureStore } from '@bhava/app-core/storage';

/**
 * Sign in with Google or a WhatsApp code, and with Apple on iOS. Never needed to browse. This feature's service is the app's
 * session (`services.session`): the client asks it for the access token before every call, and it keeps the refresh token in
 * SecureStore and nowhere else.
 */

function deviceRandom() {
  const Crypto = require('expo-crypto');
  return {
    random: (length) => Crypto.getRandomBytesAsync(length),
    sha256: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.BASE64 }),
    sha256Hex: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
  };
}

export default {
  name: 'sign-in',
  screens: [
    { name: 'index', path: 'sign-in', title: 'sign-in.title', component: SignInScreen },
  ],
  nav: null,
  service(services) {
    const { brand } = services.config;
    const store = services.secureStore ?? createSecureStore({ prefix: `shopper.t${brand.tenantId}` });
    const device = services.deviceCrypto ?? deviceRandom();
    const session = createSession({
      client: services.client,
      store,
      scheme: brand.scheme,
      // What failed for want of a session is read again once there is one.
      onReady: () => services.queryClient.refetchQueries({ predicate: (query) => query.state.status === 'error' }),
      random: device.random,
      sha256: device.sha256,
      // What the shopper leaves behind: every answer kept for them, and the bag.
      beforeLeave: [() => services.notifications?.forget?.()],
      onWipe: [
        () => {
          services.queryClient.removeQueries({ queryKey: ['buy'] });
          services.queryClient.getMutationCache().clear();
        },
        () => services.cart?.wipe?.(),
        () => services.checkout?.attempt?.reset?.(),
      ],
    });
    let before = session.getState().status;
    session.subscribe(() => {
      const now = session.getState().status;
      if (now === 'signedIn' && before !== 'signedIn') {
        // Signing in joins the bag on this phone to the one the server keeps, and drops every guest answer.
        services.queryClient.removeQueries({ queryKey: ['buy'] });
        services.cart?.mergeWithServer?.().catch(() => {});
      }
      before = now;
    });
    return Object.freeze({ ...session, sha256Hex: device.sha256Hex });
  },
  strings: {
    en: {
      'sign-in.title': 'Sign in',
      'sign-in.heading': 'Sign in to {brand}',
      'sign-in.body': 'Sign in to see your orders, saved addresses and points. You never need to sign in to browse or to buy.',
      'sign-in.google': 'Continue with Google',
      'sign-in.apple': 'Continue with Apple',
      'sign-in.whatsapp': 'Continue with a WhatsApp code',
      'sign-in.phone': 'WhatsApp number',
      'sign-in.phoneHint': 'We send a 6-digit code on WhatsApp.',
      'sign-in.sendCode': 'Send code',
      'sign-in.code': '6-digit code',
      'sign-in.verify': 'Sign in',
      'sign-in.resend': 'Send a new code',
      'sign-in.cancelled': 'Sign-in was cancelled.',
      'sign-in.failed': 'Sign-in did not work. Please try again.',
      'sign-in.back': 'Not now',
    },
    hi: {
      'sign-in.title': 'साइन इन',
      'sign-in.heading': '{brand} में साइन इन करें',
      'sign-in.body': 'अपने ऑर्डर, सहेजे हुए पते और पॉइंट देखने के लिए साइन इन करें। ब्राउज़ करने या ख़रीदने के लिए साइन इन ज़रूरी नहीं है।',
      'sign-in.google': 'Google से जारी रखें',
      'sign-in.apple': 'Apple से जारी रखें',
      'sign-in.whatsapp': 'WhatsApp कोड से जारी रखें',
      'sign-in.phone': 'WhatsApp नंबर',
      'sign-in.phoneHint': 'हम WhatsApp पर 6 अंकों का कोड भेजेंगे।',
      'sign-in.sendCode': 'कोड भेजें',
      'sign-in.code': '6 अंकों का कोड',
      'sign-in.verify': 'साइन इन करें',
      'sign-in.resend': 'नया कोड भेजें',
      'sign-in.cancelled': 'साइन इन रद्द हुआ।',
      'sign-in.failed': 'साइन इन नहीं हो सका। कृपया फिर कोशिश करें।',
      'sign-in.back': 'अभी नहीं',
    },
  },
};
