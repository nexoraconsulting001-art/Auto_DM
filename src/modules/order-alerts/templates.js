/**
 * The WhatsApp message templates every business needs (PRD 9.3, 9.15, 9.16, 9.17, 9.19). One structure for all: the
 * same names, categories and bodies at every business, filled with that business's own name and links. The business's
 * WhatsApp account submits them for Meta's review (whatsappTemplates.sync), and the shopper-message gate sends one only
 * once it is approved.
 *
 * Each body names its values {{1}}, {{2}}, ... and `params` says what goes in each, in order. A module that sends one
 * passes ctx.shopperMessages.send({ template: { purpose, params } }) with its values in exactly that order:
 *
 *   order_placed, order_paid, order_shipped, order_delivered, order_cancelled, order_refunded
 *                    [first name, order number, store name, order page link]                    (this module)
 *   otp              [code]                                                                      (shoppers)
 *   cart_reminder    [first name, store name, cart link]                                         (abandoned-cart)
 *   review_request   [first name, order number, store name, review link]                         (reviews)
 *   return_update    [first name, order number, store name, return page link]                    (returns)
 *
 * The words are the seller's voice and never the platform's: no body names it. Links are the seller's own direct links.
 */
export const TEMPLATE_LANGUAGE = 'en';

const t = (category, body, params) => Object.freeze({ category, body, params: Object.freeze(params) });
const ORDER_PARAMS = ['first name', 'order number', 'store name', 'order page link'];

export const WHATSAPP_TEMPLATES = Object.freeze({
  order_placed: t('utility', 'Hi {{1}}, thank you for your order {{2}} at {{3}}. We will message you again when it ships. See your order: {{4}}', ORDER_PARAMS),
  order_paid: t('utility', 'Hi {{1}}, we have received your payment for order {{2}} at {{3}}. We are getting it ready. See your order: {{4}}', ORDER_PARAMS),
  order_shipped: t('utility', 'Hi {{1}}, your order {{2}} from {{3}} is on its way. Follow it here: {{4}}', ORDER_PARAMS),
  order_delivered: t('utility', 'Hi {{1}}, your order {{2}} from {{3}} has been delivered. We hope you love it. Your order: {{4}}', ORDER_PARAMS),
  order_cancelled: t('utility', 'Hi {{1}}, your order {{2}} at {{3}} has been cancelled. Details: {{4}}', ORDER_PARAMS),
  order_refunded: t('utility', 'Hi {{1}}, a refund for your order {{2}} at {{3}} has been processed. Details: {{4}}', ORDER_PARAMS),
  otp: t('authentication', '{{1}} is your verification code. For your security, do not share this code.', ['code']),
  cart_reminder: t('marketing', 'Hi {{1}}, you left something in your bag at {{2}}. Pick up where you left off: {{3}}', ['first name', 'store name', 'cart link']),
  review_request: t('marketing', 'Hi {{1}}, how was your order {{2}} from {{3}}? Tell us here: {{4}}', ['first name', 'order number', 'store name', 'review link']),
  return_update: t('utility', 'Hi {{1}}, there is an update on the return for your order {{2}} at {{3}}. See it here: {{4}}', ['first name', 'order number', 'store name', 'return page link']),
});
export const TEMPLATE_PURPOSES = Object.freeze(Object.keys(WHATSAPP_TEMPLATES));

/** The template's name at WhatsApp: the purpose itself, the same at every business (names are per WhatsApp account). */
export const templateName = (purpose) => purpose;

const EXAMPLES = Object.freeze({
  'first name': 'Asha',
  'order number': 'A1042',
  'store name': 'Your Store',
  'order page link': 'https://yourstore.example/order/x7Kp2',
  'cart link': 'https://yourstore.example/cart/restore/x7Kp2',
  'review link': 'https://yourstore.example/account/orders/A1042',
  'return page link': 'https://yourstore.example/account/orders/A1042/return',
  code: '482913',
});

/** What createTemplate submits for review: the body with an example for every value, as Meta asks. */
export function templateComponents(purpose) {
  const spec = WHATSAPP_TEMPLATES[purpose];
  if (!spec) throw new Error(`No template for ${purpose}`);
  if (spec.category === 'authentication') {
    // Authentication templates use WhatsApp's own fixed wording, with a security line, an expiry and a copy button.
    return [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 5 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ];
  }
  return [{ type: 'BODY', text: spec.body, example: { body_text: [spec.params.map((p) => EXAMPLES[p] ?? 'example')] } }];
}

/** WhatsApp's review status, in the four words the table keeps. Anything WhatsApp may add later reads as not approved. */
export function reviewStatus(remote) {
  const s = String(remote ?? '').toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  if (['paused', 'disabled', 'pending_deletion', 'deleted', 'limit_exceeded', 'archived'].includes(s)) return 'paused';
  return 'pending';
}
