import PaymentScreen from './PaymentScreen.js';

/** Paying for a placed order through the pay package, and what the server then says of it (P-29). */
export default {
  name: 'payment',
  screens: [
    { name: 'index', path: 'pay/:token', title: 'payment.title', component: PaymentScreen },
  ],
  nav: null,
  strings: {
    en: {
      'payment.title': 'Payment',
      'payment.working': 'Taking you to the payment page…',
      'payment.failedTitle': 'The payment did not go through',
      'payment.failedBody': 'Nothing was taken. Your cart is as you left it, so you can try again.',
      'payment.cancelledTitle': 'Payment not finished',
      'payment.cancelledBody': 'Your cart is safe and nothing is lost. You can pay now or come back later.',
      'payment.confirmingTitle': 'Confirming your payment',
      'payment.confirmingBody': 'The bank is still telling us. This can take a minute. Your order shows as paid as soon as it is confirmed.',
      'payment.again': 'Try again',
      'payment.viewOrder': 'See my order',
      'payment.backToCart': 'Back to cart',
    },
    hi: {
      'payment.title': 'भुगतान',
      'payment.working': 'आपको भुगतान पेज पर ले जा रहे हैं…',
      'payment.failedTitle': 'भुगतान नहीं हो सका',
      'payment.failedBody': 'कुछ नहीं कटा। आपका कार्ट जैसा था वैसा ही है, आप फिर कोशिश कर सकते हैं।',
      'payment.cancelledTitle': 'भुगतान पूरा नहीं हुआ',
      'payment.cancelledBody': 'आपका कार्ट सुरक्षित है और कुछ नहीं खोया। आप अभी भुगतान करें या बाद में लौटें।',
      'payment.confirmingTitle': 'आपका भुगतान पक्का हो रहा है',
      'payment.confirmingBody': 'बैंक से जवाब आना बाकी है। इसमें एक मिनट लग सकता है। पक्का होते ही ऑर्डर “भुगतान हुआ” दिखेगा।',
      'payment.again': 'फिर कोशिश करें',
      'payment.viewOrder': 'मेरा ऑर्डर देखें',
      'payment.backToCart': 'कार्ट पर लौटें',
    },
  },
};
