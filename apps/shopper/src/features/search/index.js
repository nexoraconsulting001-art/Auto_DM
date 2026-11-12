import SearchScreen from './SearchScreen.js';

/** Search the shop. */
export default {
  name: 'search',
  screens: [
    { name: 'index', path: 'search', title: 'search.title', component: SearchScreen },
  ],
  nav: null,
  strings: {
    en: { 'search.title': 'Search', 'search.placeholder': 'Search products', 'search.hint': 'Type what you are looking for', 'search.none': 'Nothing found for “{term}”' },
    hi: { 'search.title': 'खोजें', 'search.placeholder': 'प्रोडक्ट खोजें', 'search.hint': 'लिखें कि आप क्या खोज रहे हैं', 'search.none': '“{term}” के लिए कुछ नहीं मिला' },
  },
};
