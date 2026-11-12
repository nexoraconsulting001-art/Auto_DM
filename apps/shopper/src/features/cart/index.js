import ShoppingCart from 'lucide-react-native/icons/shopping-cart';
import CartScreen from './CartScreen.js';
import { createCart } from './cart.js';
import { lineOf } from './buy.js';

/**
 * The bag: lines priced by the server, quantities, and the way to checkout. The bag itself (cart.js) keeps what was chosen
 * and nothing about money; it is `services.cart`, which the product screen adds to.
 */

/** The device's small key-value file, when this build has it. */
function deviceStorage() {
  try {
    return require('expo-sqlite/kv-store').default;
  } catch {
    return null;
  }
}

export default {
  name: 'cart',
  screens: [
    { name: 'index', path: 'cart', title: 'cart.title', component: CartScreen, link: true },
  ],
  nav: { label: 'cart.title', order: 40, icon: ShoppingCart },
  service(services) {
    const tenantId = services.config.brand.tenantId;
    const remote = {
      active: () => services.session?.getState().status === 'signedIn',
      put: async (lines) => {
        const answer = await services.client.call('cartPut', { body: { lines: lines.map(lineOf) } });
        return (answer?.lines ?? []).map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty }));
      },
    };
    const cart = createCart({ storage: services.buyStorage ?? deviceStorage(), storageKey: `shopper.cart.t${tenantId}`, remote });
    cart.load();
    return cart;
  },
  strings: {
    en: {
      'cart.title': 'Cart',
      'cart.emptyTitle': 'Your cart is empty',
      'cart.emptyBody': 'Things you add show up here.',
      'cart.startShopping': 'Start shopping',
      'cart.subtotal': 'Items',
      'cart.discount': 'Discount',
      'cart.points': 'Points used',
      'cart.shipping': 'Delivery',
      'cart.free': 'Free',
      'cart.codFee': 'Cash on delivery fee',
      'cart.tax': 'Tax',
      'cart.total': 'Total',
      'cart.advance': 'Pay now',
      'cart.balance': 'Pay on delivery',
      'cart.soldOut': 'Sold out',
      'cart.gone': 'No longer available',
      'cart.capped': 'Quantity changed to what is left',
      'cart.less': 'One fewer',
      'cart.more': 'One more',
      'cart.remove': 'Remove',
      'cart.recheck': 'Prices are checked again when you place your order.',
      'cart.stuck': 'Remove the items that cannot be bought to carry on.',
      'cart.checkout': 'Checkout',
      'cart.signInTitle': 'Sign in to see this',
      'cart.signInBody': 'Sign in with Google or a WhatsApp code to see your account.',
      'cart.signInButton': 'Sign in',
    },
    hi: {
      'cart.title': 'कार्ट',
      'cart.emptyTitle': 'आपका कार्ट खाली है',
      'cart.emptyBody': 'जो चीज़ें आप जोड़ेंगे, वे यहाँ दिखेंगी।',
      'cart.startShopping': 'खरीदारी शुरू करें',
      'cart.subtotal': 'सामान',
      'cart.discount': 'छूट',
      'cart.points': 'इस्तेमाल हुए पॉइंट',
      'cart.shipping': 'डिलीवरी',
      'cart.free': 'मुफ़्त',
      'cart.codFee': 'कैश ऑन डिलीवरी शुल्क',
      'cart.tax': 'कर',
      'cart.total': 'कुल',
      'cart.advance': 'अभी भुगतान',
      'cart.balance': 'डिलीवरी पर भुगतान',
      'cart.soldOut': 'ख़त्म हो गया',
      'cart.gone': 'अब उपलब्ध नहीं',
      'cart.capped': 'मात्रा बचे हुए स्टॉक के अनुसार बदली गई',
      'cart.less': 'एक कम',
      'cart.more': 'एक और',
      'cart.remove': 'हटाएँ',
      'cart.recheck': 'ऑर्डर देते समय कीमतें फिर से जाँची जाती हैं।',
      'cart.stuck': 'आगे बढ़ने के लिए जो चीज़ें ख़रीदी नहीं जा सकतीं, उन्हें हटाएँ।',
      'cart.checkout': 'चेकआउट',
      'cart.signInTitle': 'इसे देखने के लिए साइन इन करें',
      'cart.signInBody': 'अपना खाता देखने के लिए Google या WhatsApp कोड से साइन इन करें।',
      'cart.signInButton': 'साइन इन',
    },
  },
};
