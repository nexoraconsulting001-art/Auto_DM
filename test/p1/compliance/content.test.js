// PRD 4.10: what a DM may say, checked when it is saved and again after its variables are filled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCLOSURE_LINE, checkContent, checkPublicReply, fillTemplate, urlsIn, withDisclosure } from '../../../src/modules/compliance/content.js';
import { BASE_WORDS, hasNegativeIntent, isOptOut, isStart, isTooShort, normalizeWord, wantsHuman } from '../../../src/modules/compliance/words.js';

const reasons = (input) => checkContent(input).map((p) => p.reason);

test('C-34: 400 Devanagari characters is 1,200 bytes and refused', () => {
  assert.deepEqual(reasons({ text: 'क'.repeat(400) }), ['content.too_long']);
});

test('the text limit is 1000 bytes exactly', () => {
  assert.deepEqual(reasons({ text: 'a'.repeat(1000) }), []);
  assert.deepEqual(reasons({ text: 'a'.repeat(1001) }), ['content.too_long']);
  assert.deepEqual(reasons({ text: 'क'.repeat(333) }), [], '999 bytes');
  assert.deepEqual(reasons({ text: 'क'.repeat(334) }), ['content.too_long'], '1,002 bytes');
});

test('with a button, 640 characters is the limit, and 1000 bytes still applies', () => {
  assert.deepEqual(reasons({ text: 'a'.repeat(640), buttonTitle: 'Go' }), []);
  assert.deepEqual(reasons({ text: 'a'.repeat(641), buttonTitle: 'Go' }), ['content.too_long']);
  assert.deepEqual(reasons({ text: 'क'.repeat(400), buttonTitle: 'Go' }), ['content.too_long']);
  assert.deepEqual(reasons({ text: 'a'.repeat(641), buttonTitle: '' }), [], 'no button: only the byte limit');
});

test('a button title is at most 20 characters, counted as characters', () => {
  assert.deepEqual(reasons({ text: 'x', buttonTitle: 'a'.repeat(20) }), []);
  assert.deepEqual(reasons({ text: 'x', buttonTitle: 'a'.repeat(21) }), ['content.button_title']);
  assert.deepEqual(reasons({ text: 'x', buttonTitle: '🔥'.repeat(20) }), [], 'an emoji is one character');
});

test('quick replies: 13 of up to 20 characters', () => {
  const reply = (title = 'ok') => ({ title, payload: 'p' });
  assert.deepEqual(reasons({ text: 'x', quickReplies: Array.from({ length: 13 }, () => reply()) }), []);
  assert.deepEqual(reasons({ text: 'x', quickReplies: Array.from({ length: 14 }, () => reply()) }), ['content.too_long']);
  assert.deepEqual(reasons({ text: 'x', quickReplies: [reply('a'.repeat(21))] }), ['content.button_title']);
});

test('C-35: asking for an OTP, card or identity number is refused, in English, Hinglish and Hindi', () => {
  for (const text of ['OTP bhejiye', 'Share the otp please', 'Send your CVV', 'your UPI PIN', 'Enter your password', 'aadhaar number bhejo', 'Aadhar card', 'your PAN card', 'share PAN', 'card number batao', 'debit card details', 'bank account number', 'IFSC code', 'ओटीपी भेजिए', 'सीवीवी', 'यूपीआई पिन', 'पासवर्ड बताइए', 'आधार नंबर', 'पैन कार्ड', 'कार्ड नंबर', 'खाता संख्या']) {
    assert.deepEqual(reasons({ text }), ['content.financial_request'], text);
  }
});

test('words that only look like a financial request are allowed', () => {
  for (const text of ['Pin code bhejiye for delivery', 'Non-stick frying pan, ₹499', 'Cotton top', 'Topper', 'आधार पर छूट', 'We accept every card']) {
    assert.deepEqual(reasons({ text }), [], text);
  }
});

test('C-37: only {first_name} and {url} are variables', () => {
  assert.deepEqual(reasons({ text: 'Hi {first_name}, see {url}' }), []);
  assert.deepEqual(reasons({ text: 'Hi {username}' }), ['content.bad_variable']);
  assert.deepEqual(reasons({ text: 'Hi {First_Name}' }), ['content.bad_variable']);
  assert.deepEqual(reasons({ text: 'Hi {constructor}' }), ['content.bad_variable']);
  assert.deepEqual(reasons({ text: 'Hi {__proto__}' }), ['content.bad_variable']);
  assert.deepEqual(reasons({ text: 'Hi {नाम}' }), ['content.bad_variable']);
  assert.deepEqual(reasons({ text: 'Hi {first name}' }), ['content.bad_variable']);
});

test('after filling, no variable may be left', () => {
  assert.deepEqual(reasons({ text: 'Hi {first_name}', filled: true }), ['content.bad_variable']);
  assert.deepEqual(reasons({ text: 'Hi Asha', filled: true }), []);
});

test('C-36: a message over the limit only after {url} is filled is caught at send', () => {
  const template = `${'a'.repeat(990)} {url}`;
  assert.deepEqual(reasons({ text: template }), []);
  assert.deepEqual(reasons({ text: fillTemplate(template, { url: 'https://example.test/abc' }), filled: true }), ['content.too_long']);
});

test('C-58: Bhava\'s name, links and handles can\'t be in a DM', () => {
  for (const text of ['Get yours on Bhava', 'Powered by Bhava', 'made with bhava', 'Visit bhava.app/x', 'www.bhava.in', 'follow @bhava', 'via Bhava', 'Download the Bhava app']) {
    assert.deepEqual(reasons({ text }), ['content.bhava_promo'], text);
  }
  assert.deepEqual(reasons({ text: 'Hi', buttonTitle: 'Open on Bhava' }), ['content.bhava_promo']);
  assert.deepEqual(reasons({ text: 'Hi', quickReplies: [{ title: 'Bhava app', payload: 'x' }] }), ['content.bhava_promo']);
  assert.deepEqual(reasons({ text: 'Hi', url: 'https://store.bhava.app/x' }), ['content.bhava_promo']);
  assert.deepEqual(reasons({ text: 'Hi', url: 'https://getbhava.in/' }), ['content.bhava_promo']);
});

test('a seller\'s own page on the neutral domain is theirs, even if that domain carries the platform\'s name', () => {
  assert.deepEqual(reasons({ text: 'Hi', url: 'https://kesar.bhava.app/r/x', ownDomain: 'bhava.app' }), []);
  assert.deepEqual(reasons({ text: 'See https://kesar.bhava.app/r/x today', ownDomain: 'bhava.app' }), []);
  assert.deepEqual(reasons({ text: 'Hi', url: 'https://kesar.bhava.app/r/x' }), ['content.bhava_promo']);
  assert.deepEqual(reasons({ text: 'See bhava.app for more', ownDomain: 'bhava.app' }), ['content.bhava_promo'], 'naming it outside a seller link is still promotion');
  assert.deepEqual(reasons({ text: 'Hi', url: 'https://getbhava.in/x', ownDomain: 'bhava.app' }), ['content.bhava_promo']);
});

test('C-61: "bhav" and "bhava" as ordinary words are allowed', () => {
  for (const text of ['Aaj ka bhav ₹499', 'kya bhava hai', 'Sahi bhava mein milega', 'Bhavana ke liye']) {
    assert.deepEqual(reasons({ text }), [], text);
  }
  assert.deepEqual(reasons({ text: 'Hi', url: 'https://shop-a.bhavya.test/' }), []);
});

test('C-60: the disclosure names nobody and counts toward the limit', () => {
  assert.doesNotMatch(DISCLOSURE_LINE, /bhava/i);
  assert.ok(withDisclosure('Hello').endsWith(DISCLOSURE_LINE));
  assert.deepEqual(reasons({ text: withDisclosure('a'.repeat(990)), filled: true }), ['content.too_long']);
});

test('a template fills its variables once, and a name can\'t smuggle one in', () => {
  assert.equal(fillTemplate('Hi {first_name}', { firstName: '{url}', url: 'https://x.test' }), 'Hi {url}');
  assert.equal(fillTemplate('{first_name}!', {}), '!');
});

test('a public reply is short, and has no link, phone number or price', () => {
  assert.deepEqual(checkPublicReply('Thanks, check your DMs!'), []);
  assert.deepEqual(checkPublicReply('a'.repeat(151)).map((p) => p.reason), ['content.too_long']);
  assert.deepEqual(checkPublicReply('see https://x.test').map((p) => p.reason), ['link.not_allowlisted']);
  assert.equal(checkPublicReply('Call 9876543210').length, 1);
  assert.equal(checkPublicReply('Only ₹499').length, 1);
});

test('links written in the text are found, without their trailing punctuation', () => {
  assert.deepEqual(urlsIn('See https://a.test/x, or (http://b.test). Thanks'), ['https://a.test/x', 'http://b.test']);
});

test('C-22, C-23: an opt-out is the whole message, in any case and with any spacing', () => {
  for (const text of ['STOP', 'stop', ' stop ', 'Unsubscribe', 'BAND KARO', 'band  karo', 'mat bhejo', 'बंद करो']) assert.equal(isOptOut(text), true, text);
  for (const text of ['please don\'t stop', 'stop it now', 'nonstop', 'stop.', 'Stop!!', 'बंद']) assert.equal(isOptOut(text), false, text);
  assert.equal(isOptOut('रोक दो'), false);
  assert.equal(isOptOut('रोक दो', ['रोक दो']), true, 'a word the business added');
});

test('START lifts an opt-out only when it is the whole message', () => {
  assert.equal(isStart('START'), true);
  assert.equal(isStart(' start '), true);
  assert.equal(isStart('start again please'), false);
});

test('C-28, C-29: complaints are negative even with the keyword in them', () => {
  for (const text of ['LINK? ordered last week, not received, fraud', 'price batao, ye fake hai kya', 'SCAM', 'paisa wapas karo', 'नकली माल', 'legal notice bhejunga', 'worst shop', 'order nahi mila']) {
    assert.equal(hasNegativeIntent(text), true, text);
  }
  for (const text of ['LINK please', 'price?', 'kitne ka hai', 'not bad', 'fakeer', 'refundable']) assert.equal(hasNegativeIntent(text), false, text);
});

test('C-30: an owner\'s word counts from then on, and it isn\'t a base word', () => {
  assert.equal(hasNegativeIntent('ye kharab hai'), false);
  assert.equal(hasNegativeIntent('ye kharab hai', ['kharab']), true);
  assert.equal(BASE_WORDS.negative.includes('kharab'), false);
});

test('a request for a human is found anywhere in the DM', () => {
  assert.equal(wantsHuman('human'), true);
  assert.equal(wantsHuman('I need a human please'), true);
  assert.equal(wantsHuman('customer care number?'), true);
  assert.equal(wantsHuman('humane treatment'), false);
});

test('emoji-only and one-character comments are too short', () => {
  for (const text of ['🔥', '🔥🔥🔥', 'a', ' ', '', '!!', '❤️']) assert.equal(isTooShort(text), true, JSON.stringify(text));
  for (const text of ['ok', 'दाम', 'hi 🔥']) assert.equal(isTooShort(text), false, text);
});

test('words are compared normalised', () => {
  assert.equal(normalizeWord('  Band   KARO '), 'band karo');
  assert.equal(normalizeWord('दाम'.normalize('NFD')), 'दाम'.normalize('NFC'));
});
