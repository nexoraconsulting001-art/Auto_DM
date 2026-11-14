import Gift from 'lucide-react-native/icons/gift';
import { OWNER_ONLY } from '@bhava/app-core/access';
import ReferralsScreen from './ReferralsScreen.js';

/** Your referral link (PRD 5.20: F-129). The same for a creator and a seller. */
export default {
  name: 'referrals',
  access: OWNER_ONLY,
  feature: null,
  routeIds: ['referrals.get', 'console:/referrals'],
  screens: [{ name: 'index', path: 'referrals', title: 'referrals.title', component: ReferralsScreen }],
  nav: { label: 'referrals.title', order: 91, icon: Gift },
  strings: {
    en: {
      'referrals.title': 'Refer a friend',
      'referrals.share': 'Your referral link',
      'referrals.how': 'When someone you refer starts a paid plan, you are rewarded once.',
      'referrals.link': 'Link to share',
      'referrals.send': 'Share the link',
      'referrals.neverDm': 'Share it on your page or with friends. Never put it inside a DM.',
      'referrals.pending': 'Signed up, not paid yet',
      'referrals.credited': 'Rewarded',
      'referrals.blocked': 'Not counted',
      'referrals.earned': 'Credit earned',
      'referrals.reward': 'Reward for each paid referral: {amount}',
      'referrals.rewardTbd': 'The reward is set by the server when a referral pays.',
      'referrals.empty': 'No one has used your link yet.',
      'referrals.blockedWhy': 'A referral from the same Instagram account, phone or payment method is not counted.',
    },
    hi: {
      'referrals.title': 'दोस्त को बताएँ',
      'referrals.share': 'आपका रेफ़रल लिंक',
      'referrals.how': 'जिसे आप बुलाएँ वह पेड प्लान शुरू करे तो आपको एक बार इनाम मिलता है।',
      'referrals.link': 'शेयर करने का लिंक',
      'referrals.send': 'लिंक शेयर करें',
      'referrals.neverDm': 'इसे अपने पेज पर या दोस्तों से शेयर करें। DM के अंदर कभी न डालें।',
      'referrals.pending': 'जुड़े, अभी भुगतान नहीं',
      'referrals.credited': 'इनाम मिला',
      'referrals.blocked': 'गिने नहीं गए',
      'referrals.earned': 'कमाया क्रेडिट',
      'referrals.reward': 'हर पेड रेफ़रल का इनाम: {amount}',
      'referrals.rewardTbd': 'रेफ़रल के भुगतान करने पर इनाम सर्वर तय करता है।',
      'referrals.empty': 'अभी किसी ने आपका लिंक इस्तेमाल नहीं किया।',
      'referrals.blockedWhy': 'उसी Instagram अकाउंट, फ़ोन या भुगतान तरीके से आया रेफ़रल नहीं गिना जाता।',
    },
  },
};
