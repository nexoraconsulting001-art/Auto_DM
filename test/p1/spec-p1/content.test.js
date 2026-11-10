// PRD 4.10: content and template variables. C-34 to C-37, C-58 to C-61.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShop, assertNoDm, assertNoPlatformText, assertRefused, buttonsOf, need, textOf, useWorld } from './support.js';

const world = useWorld();
const DEVANAGARI = 'भ'; // 3 bytes in UTF-8

const save = async (shop, o) => shop.tryAutomation({ mediaId: await shop.reel(), ...o });
const variant = (body, extra = {}) => ({ label: 'A', body, buttonTitle: 'Open the link', fallbackText: 'Open: {url}', ...extra });
const patch = (shop, id, body) => shop.api(`/automations/${id}`, { method: 'PATCH', body });

test('C-34: 400 Devanagari characters, 1,200 bytes, are refused at save, content.too_long', async () => {
  const shop = await addShop(world);
  assertRefused(await save(shop, { body: DEVANAGARI.repeat(400) }), 'content.too_long');
});

test('C-34: exactly 1,000 bytes can be saved, and 1,001 can\'t', async () => {
  const shop = await addShop(world);
  need(await save(shop, { body: `${DEVANAGARI.repeat(333)}x` }), 201, '1,000 bytes');
  assertRefused(await save(shop, { body: `${DEVANAGARI.repeat(333)}xy` }), 'content.too_long', '1,001 bytes');
});

test('C-34: four-byte emoji count as four bytes', async () => {
  const shop = await addShop(world);
  need(await save(shop, { body: '🔥'.repeat(250) }), 201, '250 emoji are 1,000 bytes');
  assertRefused(await save(shop, { body: `${'🔥'.repeat(250)}!` }), 'content.too_long', '1,001 bytes of emoji');
});

test('C-34: over-limit content is refused and never cut: what is stored is what was written', async () => {
  const shop = await addShop(world);
  const body = `${DEVANAGARI.repeat(300)} end`;
  const saved = need(await save(shop, { body }), 201, 'Save').json();
  assert.equal(saved.variants[0].body, body);
});

for (const field of ['fallbackText', 'body']) {
  test(`C-34: the byte limit applies to ${field}`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, { variants: [variant('ok', { [field]: DEVANAGARI.repeat(400) })] }), 'content.too_long');
  });
}

for (const field of ['linkMessage', 'followupText']) {
  test(`C-34: the byte limit applies to ${field}`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, { [field]: DEVANAGARI.repeat(400), followupEnabled: field === 'followupText' }), 'content.too_long');
  });
}

test('C-34: the same limit holds on a PATCH', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  assertRefused(await patch(shop, auto.id, { variants: [variant(DEVANAGARI.repeat(400))] }), 'content.too_long');
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).variants[0].body, auto.variants[0].body);
});

test('C-34: a button template\'s text stops at 640 characters', async () => {
  const shop = await addShop(world);
  need(await save(shop, { body: 'x'.repeat(640) }), 201, '640 characters');
  assertRefused(await save(shop, { body: 'x'.repeat(641) }), 'content.too_long', '641 characters');
});

test('C-34: a button title stops at 20 characters, counted in characters', async () => {
  const shop = await addShop(world);
  need(await save(shop, { buttonTitle: 'x'.repeat(20) }), 201, '20 characters');
  need(await save(shop, { buttonTitle: DEVANAGARI.repeat(20) }), 201, '20 Devanagari characters');
  assertRefused(await save(shop, { buttonTitle: 'x'.repeat(21) }), 'content.button_title', '21 characters');
});

for (const field of ['tapButtonTitle', 'linkButtonTitle']) {
  test(`C-34: ${field} stops at 20 characters`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, { [field]: 'x'.repeat(21) }), 'content.button_title');
  });
}

test('C-34: no more than 13 quick replies, of 20 characters each', async () => {
  const shop = await addShop(world);
  const reply = (i) => ({ title: `Q${i}`, payload: `p${i}` });
  need(await save(shop, { variants: [variant('Hi', { quickReplies: Array.from({ length: 13 }, (_, i) => reply(i)) })] }), 201, '13 quick replies');
  assert.equal((await save(shop, { variants: [variant('Hi', { quickReplies: Array.from({ length: 14 }, (_, i) => reply(i)) })] })).status, 400);
  assert.equal((await save(shop, { variants: [variant('Hi', { quickReplies: [{ title: 'x'.repeat(21), payload: 'p' }] })] })).status, 400);
});

test('C-34: no more than 4 ice breakers', async () => {
  const shop = await addShop(world);
  const item = { question: 'What sizes?', templateBody: 'S to XL' };
  need(await shop.api('/ice-breakers', { method: 'PUT', body: { items: [item, item, item, item] } }), 200, '4 ice breakers');
  assert.equal((await shop.api('/ice-breakers', { method: 'PUT', body: { items: [item, item, item, item, item] } })).status, 400);
});

test('C-34: the preview names the problem and the size as the owner types', async () => {
  const shop = await addShop(world);
  const preview = await shop.call('/automations/preview', 200, { method: 'POST', body: { body: DEVANAGARI.repeat(400) } });
  assert.equal(preview.bytes, 1200);
  assert.equal(preview.maxBytes, 1000);
  assert.ok(preview.problems.some((p) => p.reason === 'content.too_long'));
});

const FINANCIAL = ['OTP bhejiye', 'otp bhejo', 'Please share your CVV', 'send your card number', 'Enter your UPI PIN', 'your password please', 'Share Aadhaar number', 'PAN number bhejo', 'अपना ओटीपी भेजें', 'आधार नंबर भेजें', 'पासवर्ड बताएं', 'कार्ड नंबर भेजिए', 'account number batao'];
for (const body of FINANCIAL) {
  test(`C-35: "${body}" is refused, content.financial_request`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, { body }), 'content.financial_request');
  });
}

for (const body of ['Ships from Japan', 'Made in Panipat', 'Top spot today', 'Keep it on the top shelf', 'Our card game is back']) {
  test(`C-35: "${body}" is ordinary text`, async () => {
    const shop = await addShop(world);
    need(await save(shop, { body }), 201, 'Ordinary text');
  });
}

const EVERY_TEXT_FIELD = {
  'the fallback': (bad) => ({ variants: [variant('Hi', { fallbackText: `${bad} {url}` })] }),
  'the button title': (bad) => ({ variants: [variant('Hi', { buttonTitle: bad })] }),
  'a quick reply': (bad) => ({ variants: [variant('Hi', { quickReplies: [{ title: bad, payload: 'p' }] })] }),
  'the second message': (bad) => ({ linkMessage: bad }),
  'the follow-up': (bad) => ({ followupEnabled: true, followupText: bad }),
};
for (const [where, build] of Object.entries(EVERY_TEXT_FIELD)) {
  test(`C-35: the check covers ${where}`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, build('OTP bhejo')), 'content.financial_request');
  });
}

test('C-35: an ice breaker is checked too', async () => {
  const shop = await addShop(world);
  assertRefused(await shop.api('/ice-breakers', { method: 'PUT', body: { items: [{ question: 'Send your OTP', templateBody: 'x' }] } }), 'content.financial_request');
});

test('C-36: 1,010 bytes once {url} is filled is blocked at send, and the owner is alerted', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { utmEnabled: false } });
  const body = `${DEVANAGARI.repeat(320)} {url}`;
  const auto = await shop.automate({ body, linkUrl: shop.siteUrl(`/p/${'a'.repeat(30)}`) });
  await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
  const [job] = await shop.jobs();
  assert.ok(['failed', 'skipped', 'cancelled'].includes(job.status), job.status);
  assert.equal(job.reason, 'content.too_long');
  const alerts = await shop.alerts();
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(JSON.stringify(alerts), /fan_/, 'No person in the alert');
});

test('C-36: exactly 1,000 bytes once filled still goes', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { utmEnabled: false } });
  const prefix = `https://${shop.siteHost}/p/`;
  const pad = DEVANAGARI.repeat(310);
  const linkUrl = `${prefix}${'a'.repeat(1000 - Buffer.byteLength(pad) - 1 - prefix.length)}`;
  const auto = await shop.automate({ body: `${pad} {url}`, linkUrl });
  await shop.comment(auto.mediaId);
  await shop.settle();
  const [dm] = await shop.dms();
  assert.ok(dm);
  assert.equal(Buffer.byteLength(textOf(dm)), 1000);
});

test('C-36: a saved template that names {first_name} is re-checked with the real name at send', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await world.meta.post('/people', { igUserId: shop.igUserId, id: person.id, name: DEVANAGARI.repeat(30) });
  const auto = await shop.automate({ body: `${DEVANAGARI.repeat(310)} {first_name}` });
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  await assertNoDm(shop);
  assert.equal((await shop.jobs())[0].reason, 'content.too_long');
  assert.equal((await shop.alerts()).length, 1);
});

test('C-36: a blocked template alerts once, not once per comment', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { utmEnabled: false } });
  const auto = await shop.automate({ body: `${DEVANAGARI.repeat(320)} {url}`, linkUrl: shop.siteUrl(`/p/${'a'.repeat(30)}`) });
  await shop.comment(auto.mediaId);
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.alerts()).length, 1);
});

for (const body of ['Hi {username}', 'Hi {USERNAME}', 'Hi {first_name} {handle}', 'Hi {url2}', 'Hi { first_name }', 'Hi {first name}', 'Hi {{url}}', 'Hi {first_name', 'Hi {}']) {
  test(`C-37: "${body}" is refused, content.bad_variable`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, { body }), 'content.bad_variable');
  });
}

for (const [where, build] of Object.entries(EVERY_TEXT_FIELD).filter(([key]) => key !== 'a quick reply' && key !== 'the button title')) {
  test(`C-37: variables are checked in ${where}`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, build('Hi {username}')), 'content.bad_variable');
  });
}

for (const body of ['Hi {first_name}', 'See {url}', '{first_name} {url}', 'No variables at all']) {
  test(`C-37: "${body}" is allowed`, async () => {
    const shop = await addShop(world);
    need(await save(shop, { body }), 201, 'Allowed variables');
  });
}

const PROMO = ['Get yours on Bhava', 'get yours on BHAVA!', 'Powered by Bhava', 'Made with Bhava', 'Try bhava.app today', 'Visit https://bhava.app/x', 'Follow @bhava for more', 'Find us at www.bhava.in', 'Bhava se kharido', 'Get yours on Bha​va'];
for (const body of PROMO) {
  test(`C-58: ${JSON.stringify(body)} is refused at save, content.bhava_promo`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, { body }), 'content.bhava_promo');
  });
}

for (const [where, build] of Object.entries({ ...EVERY_TEXT_FIELD })) {
  test(`C-58: the promo check covers ${where}`, async () => {
    const shop = await addShop(world);
    assertRefused(await save(shop, build('Get yours on Bhava')), 'content.bhava_promo');
  });
}

test('C-58: an ice breaker can\'t carry the name either', async () => {
  const shop = await addShop(world);
  assertRefused(await shop.api('/ice-breakers', { method: 'PUT', body: { items: [{ question: 'Made with Bhava?', templateBody: 'x' }] } }), 'content.bhava_promo');
});

test('C-58: a link destination on a Bhava domain is refused', async () => {
  const shop = await addShop(world);
  assertRefused(await save(shop, { linkUrl: 'https://bhava.app/x' }));
});

test('C-59: a Free-plan DM has no platform name, link or badge in its text, buttons or link', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const auto = await shop.automate({ linkMode: 'two_tap' });
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  const [first] = await shop.dms();
  assertNoPlatformText(first.message, 'The first DM');
  await shop.tap(person, buttonsOf(first)[0].payload);
  await shop.settle();
  const second = (await shop.dms()).at(-1);
  assert.notEqual(second.id, first.id);
  assertNoPlatformText(second.message, 'The second DM');
});

test('C-59: nothing is added to the owner\'s words on the Free plan', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const auto = await shop.automate({ linkMode: 'two_tap', body: 'Tap below for the link.' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal(textOf((await shop.dms())[0]), 'Tap below for the link.');
});

const settings = (shop, body) => shop.call('/compliance/settings', 200, { method: 'PATCH', body });

test('C-60: the "Automated reply" note is off until the seller switches it on', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.doesNotMatch(textOf((await shop.dms())[0]), /automated reply/i);
});

test('C-60: switched on, a neutral line goes on each automated DM and names nobody', async () => {
  const shop = await addShop(world);
  await settings(shop, { disclosureEnabled: true });
  const auto = await shop.automate({ linkMode: 'two_tap' });
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  const [first] = await shop.dms();
  assert.match(textOf(first), /automated reply/i);
  assertNoPlatformText(first.message);
  await shop.tap(person, buttonsOf(first)[0].payload);
  await shop.settle();
  const second = (await shop.dms()).at(-1);
  assert.match(textOf(second), /automated reply/i);
  assertNoPlatformText(second.message);
});

test('C-60: the note counts toward the byte limit', async () => {
  const shop = await addShop(world);
  await settings(shop, { disclosureEnabled: true });
  const res = await save(shop, { body: `${DEVANAGARI.repeat(333)}x` });
  if (res.status === 201) {
    const auto = res.json();
    await shop.setState(auto.id, 'live');
    await shop.comment(auto.triggers[0].mediaId);
    await shop.settle();
    assert.equal((await shop.dms()).length, 0);
    assert.equal((await shop.jobs())[0].reason, 'content.too_long');
  } else {
    assertRefused(res, 'content.too_long');
  }
});

test('C-60: a manual reply from the owner carries no automated note', async () => {
  const shop = await addShop(world);
  await settings(shop, { disclosureEnabled: true });
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  const thread = await shop.thread(person.id);
  await shop.call(`/inbox/threads/${thread.id}/reply`, 200, { method: 'POST', body: { text: 'Hi from the owner' } });
  await shop.settle();
  const dm = (await shop.dms({ recipientId: person.id })).at(-1);
  assert.equal(textOf(dm), 'Hi from the owner');
});

for (const body of ['Aaj ka bhav ₹499', 'bhav kya hai', 'Aaj ka bhava kya hai', 'BHAV 499', 'Bhavana ka order', 'दाम और भाव']) {
  test(`C-61: "${body}" is allowed; not content.bhava_promo`, async () => {
    const shop = await addShop(world);
    const res = need(await save(shop, { body }), 201, 'Normal Hinglish');
    assert.equal(res.json().variants[0].body, body);
  });
}

test('C-61: the same text passes at send too and reaches the shopper unchanged', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ body: 'Aaj ka bhav ₹499' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal(textOf((await shop.dms())[0]), 'Aaj ka bhav ₹499');
});
