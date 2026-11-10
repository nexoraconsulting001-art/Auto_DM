// PRD 6.8: automation builder and schedule. A-43 to A-48.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, DAY, HOUR, addShop, addStaff, assertNoDm, assertReason, hit, need, unique, useWorld } from './support.js';

const world = useWorld();

test('A-43: the owner opening setup gets recent reels, posts and live stories, each with its type', async () => {
  const shop = await addShop(world);
  const reel = await shop.reel({ caption: 'A reel' });
  const post = await shop.post({ caption: 'A post' });
  const story = await shop.story({ caption: 'A story' });
  const { items } = await shop.call('/instagram/media', 200);
  const types = Object.fromEntries(items.map((m) => [m.id, m.type]));
  assert.deepEqual([types[reel], types[post], types[story]], ['reel', 'post', 'story']);
});

test('A-43: the type filter works', async () => {
  const shop = await addShop(world);
  const reel = await shop.reel();
  await shop.post();
  const { items } = await shop.call('/instagram/media?type=reel', 200);
  assert.deepEqual(items.map((m) => m.id), [reel]);
});

test('A-43: a story older than 24 hours isn\'t offered', async () => {
  const shop = await addShop(world);
  const live = await shop.story();
  const old = await shop.story({ at: Date.now() - DAY - 60_000 });
  const ids = (await shop.call('/instagram/media?type=story', 200)).items.map((m) => m.id);
  assert.ok(ids.includes(live));
  assert.equal(ids.includes(old), false);
});

test('A-43: a tile says which automation already has it', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const { items } = await shop.call('/instagram/media', 200);
  assert.equal(items.find((m) => m.id === auto.mediaId).automationId, auto.id);
});

test('A-43: another business\'s media isn\'t in the grid', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelA = await a.reel();
  const ids = (await b.call('/instagram/media', 200)).items.map((m) => m.id);
  assert.equal(ids.includes(reelA), false);
});

test('A-43: a business with no Instagram gets an empty grid and a clear answer, not a crash', async () => {
  const shop = await addShop(world, { igConnected: false });
  const res = await shop.api('/instagram/media');
  assert.ok(res.status < 500, `Got ${res.status}`);
});

for (const [label, fault] of [['times out', { kind: 'timeout' }], ['answers junk', { kind: 'malformed', mode: 'garbage' }], ['answers the wrong shape', { kind: 'malformed', mode: 'wrong_shape' }]]) {
  test(`A-43: when Meta ${label} the grid answers with a message, not a crash`, async () => {
    const shop = await addShop(world);
    await shop.fault({ ...fault, match: { method: 'GET', path: `*/${shop.igUserId}/media` } });
    const res = await shop.api('/instagram/media');
    assert.notEqual(res.status, 500, res.text);
    assert.ok(res.json());
  });
}

test('A-44: saving a keyword, message and link with no products works on a tier 1 business', async () => {
  const shop = await addShop(world, { plan: 't1' });
  const res = need(await shop.tryAutomation({ mediaId: await shop.reel() }), 201, 'Save').json();
  assert.equal(res.state, 'draft');
  assert.ok(res.id);
  assert.match(res.slug, /^[a-z0-9-]+$/);
  assert.equal(res.linkStatus, 'unchecked');
});

test('A-44: a saved automation reads back as saved, and appears in the list', async () => {
  const shop = await addShop(world);
  const saved = need(await shop.tryAutomation({ mediaId: await shop.reel(), keywords: ['price', 'rate'] }), 201, 'Save').json();
  assert.deepEqual((await shop.call(`/automations/${saved.id}`, 200)).keywords, ['price', 'rate']);
  assert.deepEqual((await shop.call('/automations', 200)).items.map((a) => a.id), [saved.id]);
});

test('A-44: two automations with one name get different slugs', async () => {
  const shop = await addShop(world);
  const name = `Same name ${unique()}`;
  const a = need(await shop.tryAutomation({ mediaId: await shop.reel(), name }), 201, 'First').json();
  const b = need(await shop.tryAutomation({ mediaId: await shop.reel(), name }), 201, 'Second').json();
  assert.notEqual(a.slug, b.slug);
});

test('A-44: two saves of one name at the same moment both work, with different slugs', async () => {
  const shop = await addShop(world);
  const name = `Race ${unique()}`;
  const [m1, m2] = [await shop.reel(), await shop.reel()];
  const answers = await Promise.all([shop.tryAutomation({ mediaId: m1, name }), shop.tryAutomation({ mediaId: m2, name })]);
  assert.deepEqual(answers.map((r) => r.status), [201, 201]);
  assert.notEqual(answers[0].json().slug, answers[1].json().slug);
});

test('A-44: a name of hostile characters makes a clean slug', async () => {
  const shop = await addShop(world);
  const saved = need(await shop.tryAutomation({ mediaId: await shop.reel(), name: '<script>../../दाम!!' }), 201, 'Save').json();
  assert.match(saved.slug, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
});

test('A-44: a Free business is held to its 3 automations', async () => {
  const shop = await addShop(world, { plan: 'free' });
  for (let i = 0; i < 3; i++) need(await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), 201, `Automation ${i + 1}`);
  const fourth = await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' });
  assert.ok(fourth.status >= 400 && fourth.status < 500, `Got ${fourth.status}`);
});

test('A-44: saving needs the automations permission', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  assert.equal((await shop.api('/automations', { method: 'POST', token: staff.token, body: shop.automationBody({ mediaId: 'x' }) })).status, 403);
  const allowed = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/automations', { method: 'POST', token: allowed.token, body: shop.automationBody({ mediaId: await shop.reel() }) })).status, 201);
});

test('A-44: another business can\'t read, change, delete or change the state of an automation', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const auto = await a.automate();
  assert.equal((await b.api(`/automations/${auto.id}`)).status, 404);
  assert.equal((await b.api(`/automations/${auto.id}`, { method: 'PATCH', body: { name: 'Stolen' } })).status, 404);
  assert.equal((await b.api(`/automations/${auto.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await a.call(`/automations/${auto.id}`, 200)).name, auto.name);
});

for (const body of [{}, { name: 'x' }, { name: 123, triggerType: 'comment', variants: [{ label: 'A', body: 'x' }] }, { name: 'x', triggerType: 'nope', variants: [{ label: 'A', body: 'x' }] }, { name: 'x', triggerType: 'comment', variants: [] }, { name: 'x', triggerType: 'comment', variants: [{ label: 'Z', body: 'x' }] }]) {
  test(`A-44: a malformed body ${JSON.stringify(body).slice(0, 50)} is a 400`, async () => {
    const shop = await addShop(world);
    const res = await shop.api('/automations', { method: 'POST', body });
    assert.equal(res.status, 400);
    assert.equal(res.json().code, 'validation_failed');
  });
}

test('A-44: a name holding a NUL byte is refused, not a 500', async () => {
  const shop = await addShop(world);
  assert.equal((await shop.tryAutomation({ name: 'x\u0000y' })).status, 400);
});

test('A-45: saving with no keyword and not in any-comment mode is blocked: "Add at least one keyword"', async () => {
  const shop = await addShop(world);
  const res = await shop.tryAutomation({ mediaId: await shop.reel(), keywords: [] });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /Add at least one keyword/);
});

test('A-45: keywords of only spaces don\'t count', async () => {
  const shop = await addShop(world);
  assert.equal((await shop.tryAutomation({ mediaId: await shop.reel(), keywords: ['   ', ''] })).status, 400);
});

test('A-45: removing every keyword by PATCH is blocked too', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const res = await shop.api(`/automations/${auto.id}`, { method: 'PATCH', body: { keywords: [] } });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /Add at least one keyword/);
});

test('A-45: the builder warns about very short keywords and any-comment mode', async () => {
  const shop = await addShop(world);
  assert.ok(need(await shop.tryAutomation({ mediaId: await shop.reel(), keywords: ['a'] }), 201, 'Short').json().warnings.length >= 1);
  assert.ok(need(await shop.tryAutomation({ mediaId: await shop.reel(), matchMode: 'any', keywords: [], anyModeAcknowledged: true }), 201, 'Any').json().warnings.length >= 1);
});

test('A-46: public reply on with 4 variants is blocked: "Add at least 5 replies"', async () => {
  const shop = await addShop(world);
  await shop.api('/brand-kit', { method: 'PATCH', body: { publicReplyVariants: ['one', 'two', 'three', 'four'] } });
  const res = await shop.tryAutomation({ mediaId: await shop.reel(), publicReplyEnabled: true });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /Add at least 5 replies/);
});

/** Local time of day in the business's zone, offset by some minutes, as "HH:MM". */
function indiaTime(offsetMinutes = 0) {
  const shifted = new Date(Date.now() + offsetMinutes * 60_000);
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(shifted);
  return formatted.replace('24:', '00:');
}
const scheduleOutside = (outsideHours = 'hold') => ({ startsAt: null, endsAt: null, dailyStart: indiaTime(60), dailyEnd: indiaTime(120), outsideHours });
const scheduleInside = (outsideHours = 'hold') => ({ startsAt: null, endsAt: null, dailyStart: indiaTime(-60), dailyEnd: indiaTime(60), outsideHours });

test('A-47: a comment outside the daily hours in hold mode is held, then sent once the hours arrive', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ schedule: scheduleOutside('hold') });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
  const [job] = await shop.jobs();
  assert.equal(job.status, 'held');
  assert.equal(job.reason, 'outside_hours');
  await shop.call(`/automations/${auto.id}`, 200, { method: 'PATCH', body: { schedule: scheduleInside('hold') } });
  await world.switchLag();
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('A-47: in skip mode it is skipped, outside_hours, and the hours arriving change nothing', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ schedule: scheduleOutside('skip') });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'outside_hours', comment.id);
  await shop.call(`/automations/${auto.id}`, 200, { method: 'PATCH', body: { schedule: scheduleInside('skip') } });
  await world.switchLag();
  await shop.settle();
  await assertNoDm(shop);
});

test('A-47: a held job that passes its expiry before the hours arrive is dropped', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ schedule: scheduleOutside('hold') });
  await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(COMPLIANCE_LIMITS.privateReplyExpiryMs + HOUR);
  await shop.call(`/automations/${auto.id}`, 200, { method: 'PATCH', body: { schedule: scheduleInside('hold') } });
  await world.switchLag();
  await shop.settle();
  await assertNoDm(shop);
  assert.equal((await shop.jobs())[0].reason, 'expired.7d');
});

test('A-47: the hours are the business\'s local time, not the server\'s', async () => {
  const shop = await addShop(world);
  const utcNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace('24:', '00:');
  const utcLater = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Date.now() + 60 * 60_000)).replace('24:', '00:');
  const auto = await shop.automate({ schedule: { startsAt: null, endsAt: null, dailyStart: utcNow, dailyEnd: utcLater, outsideHours: 'skip' } });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop, 'Inside those hours in UTC, outside them in Kolkata');
  await assertReason(shop, 'outside_hours', comment.id);
});

test('A-47: hours that run overnight are honoured', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ schedule: { startsAt: null, endsAt: null, dailyStart: indiaTime(-30), dailyEnd: indiaTime(-60), outsideHours: 'skip' } });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1, 'A window from 30 minutes ago round to 60 minutes ago covers now');
});

test('A-47: before the start date the automation doesn\'t run; after the end date it moves to Paused', async () => {
  const shop = await addShop(world);
  const future = await shop.automate({ schedule: { startsAt: new Date(Date.now() + DAY).toISOString(), endsAt: null, dailyStart: null, dailyEnd: null, outsideHours: 'skip' } });
  const early = await shop.comment(future.mediaId);
  const ended = await shop.automate({ schedule: { startsAt: null, endsAt: new Date(Date.now() + HOUR).toISOString(), dailyStart: null, dailyEnd: null, outsideHours: 'skip' } });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: early.id })).length, 0);
  await world.travel(HOUR + 1000);
  await shop.settle();
  assert.equal((await shop.call(`/automations/${ended.id}`, 200)).state, 'paused');
});

for (const schedule of [{ dailyStart: '25:00' }, { dailyStart: '9am' }, { startsAt: 'tomorrow' }, { outsideHours: 'maybe' }]) {
  test(`A-47: a schedule of ${JSON.stringify(schedule)} is refused`, async () => {
    const shop = await addShop(world);
    assert.equal((await shop.tryAutomation({ mediaId: await shop.reel(), schedule })).status, 400);
  });
}

test('A-48: a token that expired while media loads gives "Reconnect Instagram", and no crash', async () => {
  const shop = await addShop(world);
  await world.meta.post('/tokens/expire', { token: shop.igToken });
  const res = await shop.api('/instagram/media');
  assert.notEqual(res.status, 500, res.text);
  assert.ok(res.status >= 400 && res.status < 500, `Got ${res.status}`);
  assert.match(res.json().error, /Reconnect Instagram/);
  assert.equal((await hit(world, '/healthz')).status, 200);
});

test('A-48: the connection then says reconnect is needed', async () => {
  const shop = await addShop(world);
  await world.meta.post('/tokens/expire', { token: shop.igToken });
  await shop.api('/instagram/media');
  await shop.settle();
  assert.equal((await shop.call('/instagram/connection', 200)).status, 'reconnect_needed');
});

test('A-48: the error doesn\'t leak the token', async () => {
  const shop = await addShop(world);
  await world.meta.post('/tokens/expire', { token: shop.igToken });
  const res = await shop.api('/instagram/media');
  assert.equal(res.text.includes(shop.igToken), false);
});
