import WishlistScreen from './WishlistScreen.js';

/** Saved products, kept by the store for a signed-in shopper. */
export default {
  name: 'wishlist',
  screens: [
    { name: 'index', path: 'wishlist', title: 'wishlist.title', component: WishlistScreen },
  ],
  nav: null,
  strings: {
    en: {
      'wishlist.title': 'Wishlist',
      'wishlist.signInBody': 'Sign in to save products and find them on any phone.',
      'wishlist.emptyTitle': 'Nothing saved yet',
      'wishlist.emptyBody': 'Tap the heart on a product to keep it here.',
      'wishlist.browse': 'Browse the store',
      'wishlist.soldOut': 'Sold out',
      'wishlist.gone': 'No longer available',
      'wishlist.add': 'Add to cart',
      'wishlist.choose': 'Choose options',
      'wishlist.added': 'Added to cart',
      'wishlist.remove': 'Remove',
    },
    hi: {
      'wishlist.title': 'विशलिस्ट',
      'wishlist.signInBody': 'प्रोडक्ट सहेजने और किसी भी फ़ोन पर पाने के लिए साइन इन करें।',
      'wishlist.emptyTitle': 'अभी कुछ सहेजा नहीं है',
      'wishlist.emptyBody': 'किसी प्रोडक्ट पर दिल दबाएँ, वह यहाँ रहेगा।',
      'wishlist.browse': 'स्टोर देखें',
      'wishlist.soldOut': 'ख़त्म हो गया',
      'wishlist.gone': 'अब उपलब्ध नहीं',
      'wishlist.add': 'कार्ट में डालें',
      'wishlist.choose': 'विकल्प चुनें',
      'wishlist.added': 'कार्ट में डाल दिया',
      'wishlist.remove': 'हटाएँ',
    },
  },
};
