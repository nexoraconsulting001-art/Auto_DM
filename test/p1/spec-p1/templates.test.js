// PRD 6.5: message templates and A/B variants. A-25 to A-30, A-74, A-75.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, addShop, assertNoPlatformText, assertRefused, assertReason, buttonsOf, isButtonTemplate, linkOf, openWorld, textOf, unique, useWorld } from './support.js';

const world = useWorld();
const FAULT_PATH = (shop) => `*/${shop.igUserId}/messages`;

test('A-25: a normal matching comment gets one button-template DM whose button opens the direct link', async () => {
  const shop = await addShop(world);
  const linkUrl = shop.siteUrl('/p/1');
  const auto = await shop.automate({ linkUrl, buttonTitle: 'See it', linkButtonTitle: 'See it' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  const dms = await shop.dms();
  assert.equal(dms.length, 1);
  assert.equal(isButtonTemplate(dms[0]), true);
  const [button] = buttonsOf(dms[0]);
  assert.equal(button.type, 'web_url');
  assert.equal(button.title, 'See it');
  assert.equal(new URL(button.url).host, shop.siteHost);
});

test('A-25: in two-tap mode the button is a postback', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal(buttonsOf((await shop.dms())[0])[0].type, 'postback');
});

test('A-25: a hostile comment and username never end up in the DM', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const from = { id: world.fan().id, username: '<script>alert(1)</script>' };
  await shop.comment(auto.mediaId, { from, text: 'price <img src=x onerror=alert(1)>' });
  await shop.settle();
  assert.doesNotMatch(JSON.stringify((await shop.dms())[0].message), /script|onerror/);
});

test('A-26: Meta rejecting the template as invalid content: one plain-text DM, sent_fallback, fallback.validation', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ fallbackText: 'Here is your link: {url}' });
  await shop.refuseSends({ code: 100 });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  const dms = await shop.dms();
  assert.equal(dms.length, 1);
  assert.equal(isButtonTemplate(dms[0]), false);
  assert.match(textOf(dms[0]), /Here is your link: https:/);
  assert.equal(new URL(linkOf(dms[0])).host, shop.siteHost);
  const [job] = await shop.jobs();
  assert.equal(job.status, 'sent_fallback');
  assert.equal(job.reason, 'fallback.validation');
  await assertReason(shop, 'fallback.validation', comment.id);
  assert.equal((await shop.sendCalls()).length, 2);
});

for (const [label, fault] of [
  ['a timeout', { kind: 'timeout' }],
  ['a 500', { kind: 'server_error' }],
  ['a 503', { kind: 'server_error', status: 503 }],
  ['a dropped connection', { kind: 'drop' }],
  ['a junk 200', { kind: 'malformed', mode: 'garbage' }],
]) {
  test(`A-26: ${label} never falls back: one call, unknown outcome`, async () => {
    const shop = await addShop(world);
    const auto = await shop.automate();
    await shop.fault({ ...fault, match: { method: 'POST', path: FAULT_PATH(shop) } });
    await shop.comment(auto.mediaId);
    await shop.settle({ ms: 6000 });
    assert.equal((await shop.sendCalls()).length, 1);
    assert.equal((await shop.jobs())[0].status, 'unknown');
  });
}

for (const [label, code, subcode] of [['a permission error', 200], ['a closed window', 10, 2534022], ['an already-replied error', 10900], ['a throttle', 613], ['a token error', 190]]) {
  test(`A-26: ${label} (code ${code}) proves nothing about the template, so there is no fallback`, async () => {
    const shop = await addShop(world);
    const auto = await shop.automate();
    await shop.refuseSends({ code, subcode });
    await shop.comment(auto.mediaId);
    await shop.settle();
    assert.equal((await shop.sendCalls()).length, 1);
    assert.equal((await shop.dms()).length, 0);
  });
}

test('A-26: a rejected fallback is the end of it: send.error, and it goes to Needs a human', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await shop.refuseSends({ code: 100, times: 2 });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, 2);
  assert.equal((await shop.dms()).length, 0);
  const [job] = await shop.jobs();
  assert.equal(job.status, 'failed');
  assert.equal(job.reason, 'send.error');
  assert.deepEqual((await shop.needsHuman()).map((i) => i.kind), ['send_failed']);
});

test('A-26: the fallback goes back through the gate: an opt-out landing between the two attempts stops it', async () => {
  const w = await openWorld({ proxy: true });
  try {
    const shop = await addShop(w);
    const auto = await shop.automate();
    const person = w.fan();
    await shop.refuseSends({ code: 100 });
    w.duringGraphCall(new RegExp(`/${shop.igUserId}/messages`), async () => {
      await shop.sql(`INSERT INTO opt_outs (tenant_id, channel, subject_hash, source) VALUES ($1, 'instagram', $2, 'dm')`, [shop.tenantId, await shop.hash(person.id)]);
    });
    await shop.comment(auto.mediaId, { from: person });
    await shop.settle();
    assert.equal((await shop.sendCalls()).length, 1, 'The fallback never reached Meta');
    assert.equal((await shop.dms()).length, 0);
    await assertReason(shop, 'optout');
  } finally {
    await w.close();
  }
});

test('A-26: without fallback text there is nothing to send: no empty message', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ fallbackText: '' });
  await shop.refuseSends({ code: 100 });
  await shop.comment(auto.mediaId);
  await shop.settle();
  for (const dm of await shop.dms()) assert.ok(textOf(dm).trim().length > 0);
});

test('A-27: a template using {username} is blocked at save, content.bad_variable', async () => {
  const shop = await addShop(world);
  assertRefused(await shop.tryAutomation({ mediaId: await shop.reel(), body: 'Hi {username}' }), 'content.bad_variable');
});

test('A-27: a template changed to use {username} at send never sends it literally', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await shop.sql(`UPDATE template_variants SET body = 'Hi {username}' WHERE tenant_id = $1`, [shop.tenantId]);
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 0, 'Checked again at send');
  assert.equal((await shop.jobs())[0].reason, 'content.bad_variable');
});

test('A-28: with no first name the DM reads correctly', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ body: 'Hi {first_name}, here is the link you asked for.' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  const text = textOf((await shop.dms())[0]);
  assert.doesNotMatch(text, /\{first_name\}|undefined|null/);
  assert.doesNotMatch(text, /Hi\s*,/, 'No dangling "Hi ,"');
  assert.doesNotMatch(text, / {2}/, 'No double space');
});

test('A-28: with a name it is used', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await world.meta.post('/people', { igUserId: shop.igUserId, id: person.id, name: 'Asha' });
  const auto = await shop.automate({ body: 'Hi {first_name}, your link.' });
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  assert.match(textOf((await shop.dms())[0]), /Hi Asha, your link\./);
});

for (const [label, fault] of [['times out', { kind: 'timeout' }], ['answers junk', { kind: 'malformed', mode: 'garbage' }], ['fails', { kind: 'server_error' }]]) {
  test(`A-28: when the profile lookup ${label}, the DM still goes without the name`, async () => {
    const shop = await addShop(world);
    const person = world.fan();
    await world.meta.post('/people', { igUserId: shop.igUserId, id: person.id, name: 'Asha' });
    const auto = await shop.automate({ body: 'Hi {first_name}, your link.' });
    await shop.fault({ ...fault, match: { method: 'GET', path: `*/${person.id}` }, times: 'forever' });
    try {
      await shop.comment(auto.mediaId, { from: person });
      await shop.settle({ ms: 6000 });
    } finally {
      await world.meta.delete('/faults');
    }
    const [dm] = await shop.dms();
    assert.ok(dm, 'The DM went');
    assert.doesNotMatch(textOf(dm), /\{first_name\}|Asha/);
  });
}

test('A-28: the preview shows the message filled in and with no name', async () => {
  const shop = await addShop(world);
  const out = await shop.call('/automations/preview', 200, { method: 'POST', body: { body: 'Hi {first_name}, see {url}', linkUrl: shop.siteUrl('/p/1') } });
  assert.doesNotMatch(out.filled, /\{first_name\}|\{url\}/);
  assert.doesNotMatch(out.withoutName, /\{first_name\}|\{url\}/);
  assert.notEqual(out.filled, out.withoutName);
  assert.match(out.filled, new RegExp(shop.siteHost));
  assert.doesNotMatch(out.withoutName, /Hi\s*,/);
});

test('A-28: a name holding template syntax isn\'t expanded', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await world.meta.post('/people', { igUserId: shop.igUserId, id: person.id, name: '{url}' });
  const auto = await shop.automate({ body: 'Hi {first_name}, your link.' });
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  assert.doesNotMatch(textOf((await shop.dms())[0]), /https?:/);
});

const twoVariants = [
  { label: 'A', body: 'Version A here', buttonTitle: 'Open A', fallbackText: 'A: {url}' },
  { label: 'B', body: 'Version B here', buttonTitle: 'Open B', fallbackText: 'B: {url}' },
];

test('A-29: 2 variants, 200 sends: about 100 each, with stats per variant', { timeout: 120_000 }, async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ variants: twoVariants });
  for (let i = 0; i < 200; i++) await shop.comment(auto.mediaId);
  await shop.settle({ ms: 60_000, roundMs: 2000 });
  const dms = await shop.dms();
  assert.equal(dms.length, 200);
  const a = dms.filter((m) => /Version A/.test(textOf(m))).length;
  const b = dms.filter((m) => /Version B/.test(textOf(m))).length;
  assert.equal(a + b, 200);
  assert.ok(a >= 70 && a <= 130, `A got ${a}, B got ${b}`);
  const stats = await shop.call(`/automations/${auto.id}/stats`, 200);
  assert.equal(stats.sends, 200);
  assert.deepEqual(stats.variants.map((v) => v.sends).sort(), [a, b].sort());
  assert.ok(stats.variants.every((v) => v.leader === false || v.sends >= 100), 'A leader only after 100 sends per variant');
});

test('A-29: a person always gets the same variant within one automation', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ variants: twoVariants, triggers: [{ channel: 'instagram', targetType: 'reel', mediaId: await shop.reel() }, { channel: 'instagram', targetType: 'reel', mediaId: await shop.reel() }] });
  const person = world.fan();
  for (const trigger of auto.triggers) await shop.comment(trigger.mediaId, { from: person });
  await shop.settle();
  const dms = await shop.dms({ recipientId: person.id });
  assert.equal(dms.length, 2);
  assert.equal(textOf(dms[0]), textOf(dms[1]));
});

test('A-29: up to 3 variants save, a 4th doesn\'t, and two with one label don\'t', async () => {
  const shop = await addShop(world);
  const three = [...twoVariants, { label: 'C', body: 'Version C', buttonTitle: 'Open C', fallbackText: 'C: {url}' }];
  assert.equal((await shop.tryAutomation({ mediaId: await shop.reel(), variants: three })).status, 201);
  assert.equal((await shop.tryAutomation({ mediaId: await shop.reel(), variants: [...three, { ...three[0], label: 'A' }] })).status, 400);
  assert.equal((await shop.tryAutomation({ mediaId: await shop.reel(), variants: [twoVariants[0], twoVariants[0]] })).status, 400);
  assert.equal(COMPLIANCE_LIMITS.variantsMax, 3);
});

test('A-29: a variant with weight 0 gets nothing', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ variants: [{ ...twoVariants[0], weight: 0 }, { ...twoVariants[1], weight: 1 }] });
  for (let i = 0; i < 6; i++) await shop.comment(auto.mediaId);
  await shop.settle();
  assert.ok((await shop.dms()).every((m) => /Version B/.test(textOf(m))));
});

test('A-29: another business can\'t read an automation\'s stats', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const auto = await a.automate();
  assert.equal((await b.api(`/automations/${auto.id}/stats`)).status, 404);
});

test('A-30: after the owner picks B all new sends use B', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ variants: twoVariants });
  const b = auto.variants.find((v) => v.label === 'B');
  const saved = await shop.call(`/automations/${auto.id}/winner`, 200, { method: 'POST', body: { variantId: b.id } });
  assert.equal(saved.winnerVariantId, b.id);
  for (let i = 0; i < 8; i++) await shop.comment(auto.mediaId);
  await shop.settle();
  const dms = await shop.dms();
  assert.equal(dms.length, 8);
  assert.ok(dms.every((m) => /Version B/.test(textOf(m))));
});

test('A-30: a winner can\'t be a variant from another automation, or another business', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const one = await a.automate({ variants: twoVariants });
  const two = await a.automate({ variants: twoVariants });
  const theirs = await b.automate({ variants: twoVariants });
  for (const variantId of [two.variants[0].id, theirs.variants[0].id, 2147483647]) {
    const res = await a.api(`/automations/${one.id}/winner`, { method: 'POST', body: { variantId } });
    assert.ok(res.status === 400 || res.status === 404, `Got ${res.status}`);
  }
  assert.equal((await a.call(`/automations/${one.id}`, 200)).winnerVariantId, null);
});

test('A-30: another business can\'t pick a winner for this automation', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const auto = await a.automate({ variants: twoVariants });
  assert.equal((await b.api(`/automations/${auto.id}/winner`, { method: 'POST', body: { variantId: auto.variants[0].id } })).status, 404);
});

test('A-74: a Free-plan automation\'s messages carry no platform name, logo, link or "powered by"', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const auto = await shop.automate({ linkMode: 'two_tap', linkUrl: `https://${shop.host}/p/lamp`, linkType: 'bhava_page' });
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  const [first] = await shop.dms();
  await shop.tap(person, buttonsOf(first)[0].payload);
  await shop.settle();
  const all = await shop.dms();
  assert.equal(all.length, 2);
  for (const dm of all) assertNoPlatformText(dm.message);
  assert.doesNotMatch(linkOf(all[1]), /bhava/i);
});

test('A-74: a Free business\'s messages are the same as a paid one\'s', async () => {
  const free = await addShop(world, { plan: 'free' });
  const paid = await addShop(world, { plan: 't5' });
  const body = `Exactly this ${unique()}`;
  const autoFree = await free.automate({ linkMode: 'two_tap', body });
  const autoPaid = await paid.automate({ linkMode: 'two_tap', body });
  await free.comment(autoFree.mediaId);
  await paid.comment(autoPaid.mediaId);
  await free.settle();
  await paid.settle();
  assert.equal(textOf((await free.dms())[0]), body);
  assert.equal(textOf((await paid.dms())[0]), body);
});

test('A-75: the seller\'s "Automated reply" note appears in each DM and names no company', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { disclosureEnabled: true } });
  const auto = await shop.automate();
  const a = await shop.comment(auto.mediaId);
  const b = await shop.comment(auto.mediaId);
  await shop.settle();
  for (const comment of [a, b]) {
    const [dm] = await shop.dms({ commentId: comment.id });
    assert.match(textOf(dm), /automated reply/i);
    assertNoPlatformText(dm.message);
    assert.doesNotMatch(textOf(dm), new RegExp(shop.name), 'It names no company');
  }
});

test('A-75: the note is on the fallback too', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { disclosureEnabled: true } });
  const auto = await shop.automate();
  await shop.refuseSends({ code: 100 });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.match(textOf((await shop.dms())[0]), /automated reply/i);
});

test('A-75: switching it on for one business doesn\'t touch another', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await a.call('/compliance/settings', 200, { method: 'PATCH', body: { disclosureEnabled: true } });
  assert.equal((await b.call('/compliance/settings', 200)).disclosureEnabled, false);
});
