// The keyword matcher, and the pure parts of messages and schedules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDIAN_PRICE_WORDS, isTooShort, matchesKeywords } from '../../../src/modules/automations/match.js';
import { chooseVariant, firstMessage, parseFaqPayload, parseTwoTapPayload, render, twoTapPayload, unknownVariables } from '../../../src/modules/automations/message.js';
import { scheduleStatus } from '../../../src/modules/automations/schedule.js';

test('A-07: "price" matches "PRICE?"', () => assert.equal(matchesKeywords('PRICE?', ['price']), true));
test('A-08: "price" does not match "priceless"', () => assert.equal(matchesKeywords('priceless', ['price']), false));
test('A-09: a matra is never a word break', () => assert.equal(matchesKeywords('भावों में', ['भाव']), false));
test('A-10: a phrase matches across any run of spaces', () => assert.equal(matchesKeywords('Kitne   ka hai?', ['kitne ka']), true));
test('A-11: a keyword stored in NFD matches text in NFC', () => assert.equal(matchesKeywords('इसका दाम'.normalize('NFC'), ['दाम'.normalize('NFD')]), true));
test('A-12: an emoji keyword matches anywhere', () => assert.equal(matchesKeywords('🔥🔥 want', ['🔥']), true));

test('an emoji matches next to letters, and with or without its style selector', () => {
  assert.equal(matchesKeywords('love❤️', ['❤️']), true);
  assert.equal(matchesKeywords('love ❤️', ['❤']), true, 'keyword without the selector');
  assert.equal(matchesKeywords('love ❤', ['❤️']), true, 'text without the selector');
});

test('a phrase mixing an emoji and a word still needs the word to stand alone', () => {
  assert.equal(matchesKeywords('🔥 deal now', ['🔥 deal']), true);
  assert.equal(matchesKeywords('🔥 dealer', ['🔥 deal']), false);
});

test('a keyword is never a pattern, and a very long comment is fine', () => {
  assert.equal(matchesKeywords('a.b', ['a?b']), false);
  assert.equal(matchesKeywords('(((', ['(']), true);
  assert.equal(matchesKeywords(`${'a '.repeat(50_000)}price`, ['price']), true);
});

test('the Indian price words preset has its eight words and matches Hindi whole words', () => {
  assert.equal(INDIAN_PRICE_WORDS.length, 8);
  assert.equal(matchesKeywords('इसकी कीमत क्या है', INDIAN_PRICE_WORDS), true);
  assert.equal(matchesKeywords('kitne ka hai', INDIAN_PRICE_WORDS), true);
  assert.equal(matchesKeywords('very nice', INDIAN_PRICE_WORDS), false);
});

test('too short means under 2 characters or only emoji', () => {
  for (const text of ['', ' ', 'k', '🔥', '🔥🔥🔥', '❤️ ❤️', '?!']) assert.equal(isTooShort(text), true, text);
  for (const text of ['ok', 'दाम', 'price 🔥']) assert.equal(isTooShort(text), false, text);
});

test('A-28: a message reads correctly with the name missing', () => {
  assert.equal(render('Hi {first_name}, here it is!', { firstName: 'Asha' }), 'Hi Asha, here it is!');
  assert.equal(render('Hi {first_name}, here it is!', {}), 'Hi, here it is!');
  assert.equal(render('Hi {first_name}!', {}), 'Hi!');
  assert.equal(render('{first_name}, your link', {}), 'your link');
  assert.equal(render('Line one\n\nLine two', {}), 'Line one\n\nLine two', 'a message with no variables is left alone');
});

test('only {first_name} and {url} are variables', () => {
  assert.deepEqual(unknownVariables('Hi {first_name} {url}'), []);
  assert.deepEqual(unknownVariables('Hi {username} {user-name} {__proto__}'), ['{username}', '{user-name}', '{__proto__}']);
});

test('one person always gets the same version, and the split follows the weights', () => {
  const variants = [{ id: 1, label: 'A', weight: 1 }, { id: 2, label: 'B', weight: 1 }];
  assert.equal(chooseVariant({ variants }, 'a:1').id, chooseVariant({ variants }, 'a:1').id);
  const counts = { 1: 0, 2: 0 };
  for (let i = 0; i < 2000; i++) counts[chooseVariant({ variants }, `a:person-${i}`).id]++;
  assert.ok(Math.abs(counts[1] - 1000) < 150, JSON.stringify(counts));

  const lopsided = [{ id: 1, label: 'A', weight: 0 }, { id: 2, label: 'B', weight: 1 }];
  for (let i = 0; i < 50; i++) assert.equal(chooseVariant({ variants: lopsided }, `k${i}`).id, 2);
  assert.equal(chooseVariant({ variants: [{ id: 1, label: 'A', weight: 0 }] }, 'k').id, 1, 'all weights zero still sends something');
  assert.equal(chooseVariant({ variants: [] }, 'k'), null);
});

test('A-30: once there is a winner everyone gets it', () => {
  const variants = [{ id: 1, label: 'A', weight: 1 }, { id: 2, label: 'B', weight: 1 }];
  for (let i = 0; i < 50; i++) assert.equal(chooseVariant({ variants, winnerVariantId: 2 }, `k${i}`).id, 2);
});

test('two-tap and ice breaker payloads round-trip and reject anything else', () => {
  const value = { automationId: 7, variantId: 9, mediaId: 'M1', commentId: 'C1' };
  assert.deepEqual(parseTwoTapPayload(twoTapPayload(value)), value);
  for (const bad of ['', 'two_tap:x:1:M:C', 'two_tap:1:2:M', 'faq:1']) assert.equal(parseTwoTapPayload(bad), null, bad);
  assert.equal(parseFaqPayload('faq:3'), 3);
  for (const bad of ['faq:5', 'faq:', 'two_tap:1']) assert.equal(parseFaqPayload(bad), null, bad);
});

test('a two-tap first message has no address anywhere, and a direct one has the link in its button and text', () => {
  const automation = { tapButtonTitle: 'Send me the link', linkButtonTitle: 'Open' };
  const variant = { body: 'See {url} now', buttonTitle: '', quickReplies: [] };
  const twoTap = firstMessage({ automation, variant, mode: 'two_tap', firstName: '', finalUrl: 'https://s.test/p', payload: 'two_tap:1:1:M:C' });
  assert.doesNotMatch(JSON.stringify(twoTap), /https?:/);
  assert.deepEqual(twoTap.button, { payload: 'two_tap:1:1:M:C', title: 'Send me the link' });
  const direct = firstMessage({ automation, variant, mode: 'direct', firstName: '', finalUrl: 'https://s.test/p' });
  assert.equal(direct.text, 'See https://s.test/p now');
  assert.deepEqual(direct.button, { url: 'https://s.test/p', title: 'Open' });
});

// Noon on a Monday in India is 06:30 UTC.
const at = (time) => new Date(`2026-11-09T${time}:00+05:30`);
const hours = { startsAt: null, endsAt: null, dailyStart: '09:00', dailyEnd: '21:00', outsideHours: 'hold' };

test('A-47: daily hours are in the business\'s time zone', () => {
  assert.equal(scheduleStatus(hours, at('12:00')).open, true);
  assert.equal(scheduleStatus(hours, at('09:00')).open, true);
  assert.equal(scheduleStatus(hours, at('21:00')).open, false);
  const late = scheduleStatus(hours, at('23:00'));
  assert.equal(late.open, false);
  assert.equal(late.nextOpenAt.toISOString(), new Date('2026-11-10T09:00:00+05:30').toISOString());
  assert.equal(scheduleStatus(hours, new Date('2026-11-09T03:00:00Z'), 'UTC').open, false, '3am UTC is outside hours there');
});

test('daily hours can cross midnight, and an unknown time zone falls back to India', () => {
  const night = { ...hours, dailyStart: '22:00', dailyEnd: '02:00' };
  assert.equal(scheduleStatus(night, at('23:30')).open, true);
  assert.equal(scheduleStatus(night, new Date('2026-11-09T01:00:00+05:30')).open, true);
  assert.equal(scheduleStatus(night, at('12:00')).open, false);
  assert.equal(scheduleStatus(hours, at('12:00'), 'Mars/Base').open, true);
});

test('start and end times: before the start it waits, after the end it has ended', () => {
  const span = { ...hours, dailyStart: null, dailyEnd: null, startsAt: at('10:00').toISOString(), endsAt: at('20:00').toISOString() };
  assert.equal(scheduleStatus(span, at('12:00')).open, true);
  assert.equal(scheduleStatus(span, at('08:00')).nextOpenAt.toISOString(), at('10:00').toISOString());
  assert.deepEqual(scheduleStatus(span, at('20:00')), { ended: true });
});
