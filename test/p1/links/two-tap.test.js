// The two-tap "Send me the link" flow, from a real postback through the compliance gate (PRD 6.13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, addShop, assertNoPlatformText, assertReason, buttonsOf, isButtonTemplate, linkOf, textOf, unique, useWorld } from '../spec-p1/support.js';

const world = useWorld();

async function firstDm(extra = {}, shopOptions = {}) {
  const shop = await addShop(world, shopOptions);
  const auto = await shop.automate({ linkMode: 'two_tap', linkUrl: shop.siteUrl('/p/direct'), ...extra });
  const person = world.fan();
  const comment = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  const [dm] = await shop.dms();
  assert.ok(dm, 'The first DM went');
  const payload = buttonsOf(dm)[0]?.payload;
  assert.ok(payload, 'The first DM has a postback button');
  return { shop, auto, person, comment, dm, payload };
}

async function tapOnce(shop, person, payload) {
  await shop.tap(person, payload);
  await shop.settle();
}

const taps = async (shop, query = '') => (await shop.call(`/links/taps${query}`, 200)).items;
const rows = (shop) => shop.sql('SELECT * FROM link_taps WHERE tenant_id = $1', [shop.tenantId]);
const linkDms = (shop, person) => shop.dms({ recipientId: person.id, kind: 'send_api' });

test('A-68: a tap is recorded against the person\'s hash, and the direct link follows as a button', async () => {
  const { shop, auto, person, payload, comment, dm } = await firstDm();
  assert.doesNotMatch(JSON.stringify(dm.message), /https?:\/\//, 'The first DM has no address in it');
  await tapOnce(shop, person, payload);
  const [row] = await rows(shop);
  assert.deepEqual([row.automation_id, row.channel, row.media_id, row.comment_id, row.tap_count, row.is_test], [auto.id, 'instagram', auto.mediaId, comment.id, 1, false]);
  assert.equal(row.subject_hash, await shop.hash(person.id));
  assert.equal(JSON.stringify(row).includes(person.id), false, 'No person\'s id in the row');
  const [link] = await linkDms(shop, person);
  assert.equal(isButtonTemplate(link), true);
  assert.deepEqual(buttonsOf(link).map((b) => [b.type, b.title]), [['web_url', 'Open the link']]);
  const url = new URL(linkOf(link));
  assert.deepEqual([url.host, url.pathname], [shop.siteHost, '/p/direct']);
  assert.deepEqual([url.searchParams.get('utm_source'), url.searchParams.get('utm_medium'), url.searchParams.get('utm_campaign'), url.searchParams.get('utm_content')], ['instagram', 'dm', auto.slug, auto.mediaId]);
});

test('A-68: the job is a normal DM with the link purpose, sent through the gate and logged', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await tapOnce(shop, person, payload);
  const [job] = await shop.jobs(`purpose = 'link'`);
  assert.deepEqual([job.kind, job.status, job.automation_id, job.media_id, job.recipient_id, job.is_test], ['dm', 'sent', auto.id, auto.mediaId, person.id, false]);
  assert.ok((await shop.events(`details->>'purpose' = 'link'`)).some((e) => e.decision === 'sent'));
});

test('A-68: the job expires 23h50m after the tap', async () => {
  const { shop, person, payload } = await firstDm();
  const before = Date.now();
  await tapOnce(shop, person, payload);
  const [job] = await shop.jobs(`purpose = 'link'`);
  const left = new Date(job.expires_at).getTime() - before;
  assert.ok(left > 23 * 60 * MINUTE + 49 * MINUTE && left < 23 * 60 * MINUTE + 51 * MINUTE, `${left}`);
});

test('PRD 6.13: neither message carries Bhava text', async () => {
  const { shop, person, payload, dm } = await firstDm({}, { plan: 'free' });
  await tapOnce(shop, person, payload);
  const [link] = await linkDms(shop, person);
  for (const message of [dm, link]) assertNoPlatformText(message.message);
});

test('PRD 6.13: the second message says what the seller wrote', async () => {
  const { shop, person, payload } = await firstDm({ linkMessage: 'Yours: {url}', linkButtonTitle: 'Shop now' });
  await tapOnce(shop, person, payload);
  const [link] = await linkDms(shop, person);
  assert.equal(buttonsOf(link)[0].title, 'Shop now');
  assert.match(textOf(link), /^Yours: https:\/\//);
});

test('PRD 6.13: with no seller text the second message is a neutral line', async () => {
  const { shop, person, payload } = await firstDm();
  await tapOnce(shop, person, payload);
  assert.equal(textOf((await linkDms(shop, person))[0]), 'Here is the link you asked for.');
});

test('PRD 6.5: {first_name} with no name known still reads correctly', async () => {
  const { shop, person, payload } = await firstDm({ linkMessage: 'Hi {first_name}, here it is.' });
  await tapOnce(shop, person, payload);
  const text = textOf((await linkDms(shop, person))[0]);
  assert.doesNotMatch(text, /[{}]/);
  assert.match(text, /here it is\.$/);
});

test('PRD 6.6: the reel\'s discount code is shown in the second message', async () => {
  const shop0 = await addShop(world);
  const mediaId = await shop0.reel();
  await shop0.call('/measurement-ids', 201, { method: 'POST', body: { mediaId, kind: 'discount_code', value: 'DIWALI10' } });
  const auto = await shop0.automate({ mediaId, linkMode: 'two_tap', linkUrl: shop0.siteUrl('/p/1') });
  const person = world.fan();
  await shop0.comment(auto.mediaId, { from: person });
  await shop0.settle();
  await tapOnce(shop0, person, buttonsOf((await shop0.dms())[0])[0].payload);
  assert.match(textOf((await linkDms(shop0, person))[0]), /Use code DIWALI10 at checkout\.$/);
});

test('PRD 6.6: a code that would break the message limit is left out, and the message still goes', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await shop.call('/measurement-ids', 201, { method: 'POST', body: { mediaId, kind: 'discount_code', value: 'DIWALI10' } });
  const long = 'x'.repeat(635);
  const auto = await shop.automate({ mediaId, linkMode: 'two_tap', linkUrl: shop.siteUrl('/p/1'), linkMessage: long });
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  await tapOnce(shop, person, buttonsOf((await shop.dms())[0])[0].payload);
  assert.equal(textOf((await linkDms(shop, person))[0]), long);
});

test('A-33: an Amazon reel\'s second message carries its tag and no UTM', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await shop.call('/measurement-ids', 201, { method: 'POST', body: { mediaId, kind: 'amazon_tag', value: 'shopa-21' } });
  const auto = await shop.automate({ mediaId, linkMode: 'two_tap', linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0' });
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  await tapOnce(shop, person, buttonsOf((await shop.dms())[0])[0].payload);
  assert.equal(linkOf((await linkDms(shop, person))[0]), 'https://www.amazon.in/dp/B0?tag=shopa-21');
});

test('A-69: a repeat tap adds a tap and not a person, and each one sends the link again', async () => {
  const { shop, person, payload } = await firstDm();
  await tapOnce(shop, person, payload);
  await tapOnce(shop, person, payload);
  const [summary] = await taps(shop);
  assert.deepEqual([summary.people, summary.taps], [1, 2]);
  assert.equal((await linkDms(shop, person)).length, 2);
});

test('A-69: the same event run twice after a crash counts once; a later tap counts again', async () => {
  const { shop, auto, person, payload, comment } = await firstDm();
  await tapOnce(shop, person, payload);
  const [{ last_tapped_at: seen }] = await rows(shop);
  const again = { automationId: auto.id, channel: 'instagram', mediaId: auto.mediaId, subject: await shop.hash(person.id), commentId: comment.id, variantId: null, isTest: false };
  await shop.repos.links.recordTap({ ...again, at: new Date(seen) });
  assert.equal((await rows(shop))[0].tap_count, 1);
  await shop.repos.links.recordTap({ ...again, at: new Date(new Date(seen).getTime() + 1000) });
  assert.equal((await rows(shop))[0].tap_count, 2);
});

test('PRD 6.9: a real tap after a test one makes the row count', async () => {
  const { shop, auto, person, payload, comment } = await firstDm();
  await tapOnce(shop, person, payload);
  await shop.sql('UPDATE link_taps SET is_test = true WHERE tenant_id = $1', [shop.tenantId]);
  assert.deepEqual(await taps(shop), []);
  await shop.repos.links.recordTap({ automationId: auto.id, channel: 'instagram', mediaId: auto.mediaId, subject: await shop.hash(person.id), commentId: comment.id, variantId: null, isTest: false, at: new Date() });
  assert.equal((await taps(shop))[0].people, 1);
});

test('A-68: a stranger tapping a copy of the button gets nothing and isn\'t counted', async () => {
  const { shop, person, payload } = await firstDm();
  const stranger = world.fan();
  await tapOnce(shop, stranger, payload);
  assert.deepEqual(await taps(shop), []);
  assert.deepEqual(await linkDms(shop, stranger), []);
  assert.deepEqual(await linkDms(shop, person), []);
  await assertReason(shop, 'unmapped');
});

test('A-68: a button naming another business\'s automation does nothing in either', async () => {
  const a = await firstDm();
  const b = await firstDm();
  await tapOnce(b.shop, b.person, a.payload);
  assert.deepEqual(await rows(b.shop), []);
  assert.deepEqual(await rows(a.shop), []);
  assert.deepEqual(await linkDms(b.shop, b.person), []);
  await assertReason(b.shop, 'unmapped');
});

for (const [label, build] of [
  ['an automation id too big for the database', () => 'two_tap:9999999999:1:M:C'],
  ['an automation that doesn\'t exist', () => 'two_tap:2147483646:1:M:C'],
  ['the wrong comment', (p) => p.replace(/:[^:]+$/, ':not-the-comment')],
  ['the wrong reel', (p) => p.replace(/^(two_tap:\d+:\d+):[^:]+:/, '$1:not-the-reel:')],
  ['the wrong automation', (p) => p.replace(/^two_tap:\d+:/, 'two_tap:1:')],
]) {
  test(`A-68: a button with ${label} is logged and nothing else happens`, async () => {
    const { shop, person, payload } = await firstDm();
    await tapOnce(shop, person, build(payload));
    assert.deepEqual(await rows(shop), []);
    assert.deepEqual(await linkDms(shop, person), []);
    await assertReason(shop, 'unmapped');
    assert.deepEqual((await shop.inbound(`field = 'messaging_postbacks'`)).map((e) => e.status), ['done'], 'The event finished cleanly');
  });
}

test('A-71: someone who has opted out is counted but gets no second message', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.dm(person, 'STOP');
  await shop.settle();
  await tapOnce(shop, person, payload);
  assert.equal((await rows(shop)).length, 1);
  assert.deepEqual(await shop.jobs(`purpose = 'link'`), []);
  assert.ok((await shop.events(`details->>'purpose' = 'link'`)).some((e) => e.reason === 'optout'));
});

test('A-71: a tap on a paused automation is counted, and the link waits, held', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.setState(auto.id, 'paused');
  await world.switchLag();
  await tapOnce(shop, person, payload);
  assert.equal((await taps(shop))[0].people, 1);
  assert.deepEqual((await shop.jobs(`purpose = 'link'`)).map((j) => [j.status, j.reason]), [['held', 'paused.automation']]);
  assert.deepEqual(await linkDms(shop, person), []);
});

test('A-71: test mode stops the second message for anyone who isn\'t a tester', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.setState(auto.id, 'test');
  await world.switchLag();
  await tapOnce(shop, person, payload);
  assert.deepEqual(await linkDms(shop, person), []);
  await assertReason(shop, 'test_mode');
});

test('A-71: a tester gets the second message in test mode, and it isn\'t counted as real', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.sql('INSERT INTO testers (tenant_id, channel, subject_hash, recipient_id) VALUES ($1, $2, $3, $4)', [shop.tenantId, 'instagram', await shop.hash(person.id), person.id]);
  await shop.setState(auto.id, 'test');
  await world.switchLag();
  await tapOnce(shop, person, payload);
  assert.equal((await linkDms(shop, person)).length, 1);
  assert.deepEqual((await shop.jobs(`purpose = 'link'`)).map((j) => j.is_test), [true]);
});

for (const [state, reason] of [['archived', 'unmapped'], ['draft', 'automation.draft']]) {
  test(`a tap on an automation that is now ${state} is counted and sends nothing, ${reason}`, async () => {
    const { shop, auto, person, payload } = await firstDm();
    await shop.setState(auto.id, state);
    await world.switchLag();
    await tapOnce(shop, person, payload);
    assert.equal((await rows(shop)).length, 1);
    assert.deepEqual(await linkDms(shop, person), []);
    await assertReason(shop, reason);
  });
}

test('a tap after the automation\'s end date sends nothing', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.sql(`UPDATE automations SET ends_at = now() - interval '1 minute' WHERE id = $1`, [auto.id]);
  await tapOnce(shop, person, payload);
  assert.deepEqual(await linkDms(shop, person), []);
  await assertReason(shop, 'paused.automation');
});

test('PRD 6.13: when the link has since been removed, the tap counts and nothing is sent', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.sql(`UPDATE automations SET link_url = '' WHERE id = $1`, [auto.id]);
  await tapOnce(shop, person, payload);
  assert.equal((await rows(shop)).length, 1);
  assert.deepEqual(await linkDms(shop, person), []);
});

test('PRD 6.13: the link sent is the automation\'s link as it is now', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.sql(`UPDATE automations SET link_url = $2 WHERE id = $1`, [auto.id, shop.siteUrl('/p/changed')]);
  await tapOnce(shop, person, payload);
  assert.equal(new URL(linkOf((await linkDms(shop, person))[0])).pathname, '/p/changed');
});

test('C-63: at send, the gate still applies the link rules to the second message', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.sql(`UPDATE automations SET link_url = 'http://plain.example/x' WHERE id = $1`, [auto.id]);
  await tapOnce(shop, person, payload);
  assert.deepEqual(await linkDms(shop, person), []);
  assert.deepEqual((await shop.jobs(`purpose = 'link'`)).map((j) => [j.status, j.reason]), [['failed', 'link.scheme']]);
});

test('PRD 4.5: a tap cancels this person\'s pending follow-up', async () => {
  const { shop, person, payload } = await firstDm({ followupEnabled: true, followupText: 'Did you find it?' });
  await shop.dm(person, 'hello');
  await shop.settle();
  assert.deepEqual((await shop.jobs(`purpose = 'followup'`)).map((j) => j.status), ['queued']);
  await tapOnce(shop, person, payload);
  assert.deepEqual((await shop.jobs(`purpose = 'followup'`)).map((j) => j.status), ['cancelled']);
});

test('A-73: a second message Meta refuses still leaves the tap counted', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.refuseSends({ code: 100, times: 2 });
  await tapOnce(shop, person, payload);
  assert.equal((await taps(shop))[0].people, 1);
  await assertReason(shop, 'send.error');
});

test('PRD 6.13: nothing about the person reaches the log or the payload', async () => {
  const { shop, person, payload } = await firstDm();
  assert.equal(payload.includes(person.id), false);
  await tapOnce(shop, person, payload);
  for (const event of await shop.events()) assert.equal(JSON.stringify(event).includes(person.id), false);
});

test('N-15: the summary is per automation and reel, filters, pages, and leaves out test taps', async () => {
  const shop = await addShop(world);
  const autos = [];
  for (let i = 0; i < 3; i++) autos.push(await shop.automate({ linkMode: 'two_tap', linkUrl: shop.siteUrl(`/p/${i}`) }));
  for (const auto of autos) {
    for (let n = 0; n < 2; n++) {
      await shop.sql(
        `INSERT INTO link_taps (tenant_id, automation_id, channel, media_id, subject_hash, tap_count) VALUES ($1, $2, 'instagram', $3, $4, $5)`,
        [shop.tenantId, auto.id, auto.mediaId, `hash-${unique()}`, n + 1],
      );
    }
  }
  await shop.sql(`INSERT INTO link_taps (tenant_id, automation_id, channel, media_id, subject_hash, is_test) VALUES ($1, $2, 'instagram', $3, 'tester', true)`, [shop.tenantId, autos[0].id, autos[0].mediaId]);
  const first = await shop.call('/links/taps?limit=2', 200);
  assert.deepEqual(first.items.map((s) => [s.automationId, s.people, s.taps]), [[autos[0].id, 2, 3], [autos[1].id, 2, 3]]);
  const rest = await shop.call(`/links/taps?limit=2&cursor=${first.nextCursor}`, 200);
  assert.deepEqual([rest.items.map((s) => s.automationId), rest.nextCursor], [[autos[2].id], null]);
  assert.deepEqual((await taps(shop, `?automationId=${autos[1].id}`)).map((s) => s.automationId), [autos[1].id]);
  assert.equal((await shop.api('/links/taps?cursor=bad-cursor')).status, 400);
});

test('N-15: one business never sees another\'s taps', async () => {
  const a = await firstDm();
  await tapOnce(a.shop, a.person, a.payload);
  const other = await addShop(world);
  assert.deepEqual(await taps(other), []);
  assert.deepEqual(await taps(other, `?automationId=${a.auto.id}`), []);
});

test('PRD 5.1: a tap row can\'t point at another business\'s automation', async () => {
  const [a, b] = [await addShop(world), await addShop(world)];
  const auto = await a.automate();
  await assert.rejects(a.sql(`INSERT INTO link_taps (tenant_id, automation_id, channel, media_id, subject_hash) VALUES ($1, $2, 'instagram', 'm', 'h')`, [b.tenantId, auto.id]));
});
