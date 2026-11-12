import Star from 'lucide-react-native/icons/star';
import { staffWith } from '@bhava/app-core/access';
import ReviewsScreen, { SavesScreen } from './ReviewsScreen.js';

/** Reviews (PRD 9.19, 9.20): moderation (approve, hide, one reply), and how often each product was saved. */
export default {
  name: 'reviews',
  access: staffWith('catalog'),
  feature: 'store.reviews',
  routeIds: ['reviews.list', 'reviews.approve', 'reviews.hide', 'reviews.reply', 'wishlist.counts', 'console:/reviews', 'console:/reviews/saves'],
  screens: [
    { name: 'index', path: 'reviews', title: 'reviews.title', component: ReviewsScreen },
    { name: 'saves', path: 'reviews/saves', title: 'reviews.saves', component: SavesScreen },
  ],
  nav: { label: 'reviews.title', order: 26, icon: Star },
  strings: {
    en: {
      'reviews.title': 'Reviews',
      'reviews.empty': 'No reviews here.',
      'reviews.spoken': '{rating} out of 5 stars for {product}',
      'reviews.photo': 'Photo from the customer',
      'reviews.yourReply': 'Your reply',
      'reviews.approve': 'Show on the store',
      'reviews.approved': 'It shows on the store now.',
      'reviews.hide': 'Hide',
      'reviews.hidden': 'Hidden from the store.',
      'reviews.reply': 'Reply',
      'reviews.replyTitle': 'Reply to this review',
      'reviews.replyIntro': 'Your reply shows under the review, once. The customer’s words are never changed.',
      'reviews.replySend': 'Post reply',
      'reviews.replied': 'Reply posted.',
      'reviews.saves': 'Saved products',
      'reviews.savesIntro': 'How many shoppers saved each product to come back to.',
      'reviews.savesEmpty': 'Nothing saved yet.',
      'reviews.savedBy': '{count} saves',
    },
    hi: {
      'reviews.title': 'रिव्यू',
      'reviews.empty': 'यहाँ कोई रिव्यू नहीं।',
      'reviews.spoken': '{product} के लिए 5 में से {rating} स्टार',
      'reviews.photo': 'ग्राहक की फ़ोटो',
      'reviews.yourReply': 'आपका जवाब',
      'reviews.approve': 'स्टोर पर दिखाएँ',
      'reviews.approved': 'अब यह स्टोर पर दिखता है।',
      'reviews.hide': 'छिपाएँ',
      'reviews.hidden': 'स्टोर से छिपा दिया।',
      'reviews.reply': 'जवाब दें',
      'reviews.replyTitle': 'इस रिव्यू का जवाब दें',
      'reviews.replyIntro': 'आपका जवाब रिव्यू के नीचे एक बार दिखेगा। ग्राहक के शब्द कभी नहीं बदले जाते।',
      'reviews.replySend': 'जवाब पोस्ट करें',
      'reviews.replied': 'जवाब पोस्ट हो गया।',
      'reviews.saves': 'सेव किए गए प्रोडक्ट',
      'reviews.savesIntro': 'कितने ग्राहकों ने हर प्रोडक्ट को बाद के लिए सेव किया।',
      'reviews.savesEmpty': 'अभी कुछ सेव नहीं हुआ।',
      'reviews.savedBy': '{count} सेव',
    },
  },
};
