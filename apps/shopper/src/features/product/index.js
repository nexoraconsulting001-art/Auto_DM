import ProductScreen from './ProductScreen.js';

/** One product: photos, options and variants, the server's price and stock, and the reels it appears in. */
export default {
  name: 'product',
  screens: [
    { name: 'index', path: 'p/:slug', title: 'product.title', component: ProductScreen, link: true },
  ],
  nav: null,
  strings: {
    en: { 'product.title': 'Product', 'product.choose': 'Choose an option to see its price and stock.', 'product.add': 'Add to cart', 'product.less': 'One less', 'product.more': 'One more', 'product.reels': 'Seen in reels' },
    hi: { 'product.title': 'प्रोडक्ट', 'product.choose': 'कीमत और स्टॉक देखने के लिए विकल्प चुनें।', 'product.add': 'कार्ट में जोड़ें', 'product.less': 'एक कम', 'product.more': 'एक ज़्यादा', 'product.reels': 'रील्स में देखा गया' },
  },
};
