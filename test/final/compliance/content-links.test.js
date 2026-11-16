// D-7 and compliance-5: the content and link rules at save (PRD 4.10, 4.11) catch malformed variables, the platform's name written
// so that it slips past a plain match, and links in the message text, with or without https://. The same text is caught at send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContent, linksIn } from '../../../src/modules/compliance/content.js';
import { checkSave, contentProblems } from '../../../src/modules/automations/rules.js';

const reasons = (input) => checkContent(input).map((p) => p.reason);
const SAVED_NUMBER = '919876543210';

/** What checkSave reads, without a database: the blocklist as migration 105 seeds it plus one malware host, and a saved number. */
const deps = {
  config: { facebookPages: true, platformDomain: 'neutral.example' },
  repos: {
    entitlements: { can: async () => true },
    settings: { getAll: async () => ({ support_whatsapp: SAVED_NUMBER }) },
    automations: { blockedHosts: async () => new Map([['bit.ly', 'shortener'], ['tinyurl.com', 'shortener'], ['evil.example', 'malware']]) },
    brandKit: { get: async () => ({ publicReplyVariants: [] }) },
  },
};
const automation = (extra = {}) => ({
  name: 'Diwali reel', triggerType: 'comment', matchMode: 'keywords', keywords: ['price'], anyModeAcknowledged: false,
  triggers: [{ channel: 'instagram', targetType: 'reel', mediaId: 'R1' }],
  variants: [{ label: 'A', body: 'Here it is {url}', weight: 1, buttonTitle: '', quickReplies: [], fallbackText: '' }],
  schedule: {}, linkUrl: 'https://shop.example/p', linkMode: 'direct', linkMessage: '', linkButtonTitle: '', tapButtonTitle: '',
  followupEnabled: false, followupText: '', publicReplyEnabled: false,
  ...extra,
});
async function refusal(input) {
  try {
    await checkSave(input, deps);
  } catch (err) {
    return { reason: err.reason, fields: Object.keys(err.fields ?? {}) };
  }
  return null;
}

test('D-7: a brace that makes no {name} is content.bad_variable at save: no close, empty, doubled', () => {
  for (const template of ['Hi {first_name', 'Hi {{url}}', 'Hi {}', 'Hi first_name}', 'Hi {{first_name}} see {url}']) {
    assert.ok(contentProblems({ template }).some((p) => p.reason === 'content.bad_variable'), template);
  }
  for (const template of ['Hi {first_name}', 'See {url}', '{first_name} {url}', 'No variables at all']) {
    assert.deepEqual(contentProblems({ template }), [], template);
  }
});

test('D-7: at send a filled-in brace is the buyer\'s own text, not a variable', () => {
  assert.deepEqual(reasons({ text: 'Hi {Asha here', filled: true }), []);
});

const HIDDEN = [
  ['a zero-width space', 'Get yours on Bha​va'],
  ['a zero-width joiner', 'Powered by B‍hava'],
  ['a soft hyphen', 'Made with Bha­va'],
  ['a Cyrillic a', 'Get yours on Bhаva'],
  ['full-width letters', 'Ｇｅｔ yours on Ｂｈａｖａ'],
  ['an accent', 'Shop on Bhavá'],
  ['a full-width domain', 'Visit ｂｈａｖａ．ａｐｐ today'],
  ['Hinglish', 'Bhava se kharido'],
  ['Hinglish with the app', 'Bhava app pe order karo'],
];
for (const [how, text] of HIDDEN) {
  test(`D-7: the platform's name with ${how} is content.bhava_promo, at save and at send`, () => {
    assert.ok(contentProblems({ template: text }).some((p) => p.reason === 'content.bhava_promo'), 'at save');
    assert.deepEqual(reasons({ text, filled: true }), ['content.bhava_promo'], 'at send');
  });
}

test('D-7: C-61 still holds: "bhav" and "bhava" as ordinary words are allowed', () => {
  for (const text of ['Aaj ka bhav ₹499', 'bhav kya hai', 'Aaj ka bhava kya hai', 'BHAV 499', 'Bhavana ka order', 'दाम और भाव', 'kya bhava hai', 'Sahi bhava mein milega', 'Bhavana ke liye', 'Sahi bhava pe milega', 'Kam bhava se kharido']) {
    assert.deepEqual(reasons({ text }), [], text);
  }
});

test('D-7: a destination on the platform\'s own domain is content.bhava_promo at save; a seller page on the neutral domain is not', async () => {
  assert.deepEqual(await refusal(automation({ linkUrl: 'https://bhava.app/x' })), { reason: 'content.bhava_promo', fields: ['linkUrl'] });
  assert.deepEqual(await refusal(automation({ linkUrl: 'https://store.getbhava.in/p' })), { reason: 'content.bhava_promo', fields: ['linkUrl'] });
  assert.equal(await refusal(automation({ linkUrl: 'https://kesar.neutral.example/p/1' })), null);
});

test('D-7 and compliance-5: a link written in the message is checked at save like the destination, with or without https://', async () => {
  const body = (text) => automation({ variants: [{ label: 'A', body: text, weight: 1, buttonTitle: '', quickReplies: [], fallbackText: '' }] });
  assert.deepEqual(await refusal(body('Buy here https://bit.ly/x')), { reason: 'link.shortener', fields: ['variants.0.body'] });
  assert.deepEqual(await refusal(body('Buy here bit.ly/x')), { reason: 'link.shortener', fields: ['variants.0.body'] });
  assert.deepEqual(await refusal(body('Buy at www.bit.ly/x today')), { reason: 'link.shortener', fields: ['variants.0.body'] });
  assert.deepEqual(await refusal(body('Read evil.example/offer first')), { reason: 'link.blocked', fields: ['variants.0.body'] });
  assert.deepEqual(await refusal(body('Pay at http://shop.example/p')), { reason: 'link.scheme', fields: ['variants.0.body'] });
  assert.deepEqual(await refusal(automation({ followupEnabled: true, followupText: 'Chat with us: wa.me/911111111111' })), { reason: 'link.not_allowlisted', fields: ['followupText'] });
  assert.deepEqual(await refusal(automation({ linkMessage: 'Or try tinyurl.com/abc', linkMode: 'two_tap' })), { reason: 'link.shortener', fields: ['linkMessage'] });
  assert.deepEqual(await refusal(automation({ variants: [{ label: 'A', body: 'Here {url}', weight: 1, buttonTitle: '', quickReplies: [], fallbackText: 'Open bit.ly/z' }] })), { reason: 'link.shortener', fields: ['variants.0.fallbackText'] });
  // What is allowed stays allowed: the saved number, the seller's own site, an email address, a price.
  assert.equal(await refusal(body(`Chat on wa.me/${SAVED_NUMBER} or see www.shop.example/p, mail a@shop.example, Rs.499`)), null);
});

test('compliance-5: linksIn finds what a buyer\'s app would make tappable, and nothing else', () => {
  assert.deepEqual(linksIn('Buy bit.ly/x or https://shop.example/p.'), ['https://shop.example/p', 'https://bit.ly/x']);
  assert.deepEqual(linksIn('www.bit.ly/x'), ['https://www.bit.ly/x']);
  assert.deepEqual(linksIn('wa.me/911111111111'), ['https://wa.me/911111111111']);
  assert.deepEqual(linksIn('ｂｉｔ．ｌｙ/x'), ['https://bit.ly/x']);
  assert.deepEqual(linksIn('mail a@shop.example, follow @shop.official, Rs.499, 2.5kg, e.g. this'), []);
});
