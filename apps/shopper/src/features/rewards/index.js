import RewardsScreen from './RewardsScreen.js';

/** Points, their history and the referral link, in the seller’s brand (P-66). */
export default {
  name: 'rewards',
  screens: [
    { name: 'index', path: 'account/rewards', title: 'rewards.title', component: RewardsScreen },
    { name: 'referral', path: 'refer/:code', title: 'rewards.title', component: RewardsScreen, link: true },
  ],
  nav: null,
  strings: {
    en: {
      'rewards.title': 'Rewards',
      'rewards.signInBody': 'Sign in to collect and spend points at {brand}.',
      'rewards.kept': 'A friend’s code is saved. It is used when you check out at {brand}.',
      'rewards.shop': 'Start shopping',
      'rewards.offTitle': 'Rewards are not on yet',
      'rewards.offBody': '{brand} has not turned rewards on.',
      'rewards.balance': 'Your points',
      'rewards.worth': 'Worth {value} at checkout',
      'rewards.pending': '{points} more points arrive after your orders are delivered',
      'rewards.expiring': '{points} points expire on {date}',
      'rewards.referTitle': 'Invite a friend',
      'rewards.share': 'Share my link',
      'rewards.history': 'History',
      'rewards.noHistory': 'Points you earn and spend show up here.',
    },
    hi: {
      'rewards.title': 'रिवॉर्ड',
      'rewards.signInBody': '{brand} पर पॉइंट कमाने और ख़र्च करने के लिए साइन इन करें।',
      'rewards.kept': 'आपके दोस्त का कोड सहेज लिया गया है। {brand} पर चेकआउट करते समय वह लग जाएगा।',
      'rewards.shop': 'खरीदारी शुरू करें',
      'rewards.offTitle': 'रिवॉर्ड अभी चालू नहीं हैं',
      'rewards.offBody': '{brand} ने रिवॉर्ड अभी चालू नहीं किए हैं।',
      'rewards.balance': 'आपके पॉइंट',
      'rewards.worth': 'चेकआउट पर {value} के बराबर',
      'rewards.pending': 'ऑर्डर पहुँचने के बाद {points} पॉइंट और मिलेंगे',
      'rewards.expiring': '{points} पॉइंट {date} को ख़त्म होंगे',
      'rewards.referTitle': 'दोस्त को बुलाएँ',
      'rewards.share': 'मेरा लिंक शेयर करें',
      'rewards.history': 'इतिहास',
      'rewards.noHistory': 'आप जो पॉइंट कमाते और ख़र्च करते हैं, वे यहाँ दिखेंगे।',
    },
  },
};
