import House from 'lucide-react-native/icons/house';
import { commonStrings } from '../../shell/strings.js';
import HomeScreen from './HomeScreen.js';

/** The store's front page: its name and logo, search, and the blocks the seller arranged, from the home feed. It also carries the lines the browsing screens share. */
export default {
  name: 'home',
  screens: [
    { name: 'index', path: '', title: 'home.title', component: HomeScreen, link: true },
  ],
  nav: { label: 'home.title', order: 10, icon: House },
  strings: {
    en: {
      ...commonStrings.en,
      'home.title': 'Home',
      'home.search': 'Search products',
      'home.shelf.reels': 'Reels',
      'home.shelf.products': 'New and popular',
      'home.block.trust': 'Why shop with us',
      'home.block.testimonials': 'What shoppers say',
      'home.block.faq': 'Questions',
    },
    hi: {
      ...commonStrings.hi,
      'home.title': 'होम',
      'home.search': 'प्रोडक्ट खोजें',
      'home.shelf.reels': 'रील्स',
      'home.shelf.products': 'नए और लोकप्रिय',
      'home.block.trust': 'हमसे क्यों खरीदें',
      'home.block.testimonials': 'ग्राहक क्या कहते हैं',
      'home.block.faq': 'सवाल',
    },
  },
};
