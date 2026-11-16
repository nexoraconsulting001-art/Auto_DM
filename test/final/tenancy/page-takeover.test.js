// tenancy-1 for Facebook Pages: another business connecting a Page this business disconnected leaves this business's inbox,
// send history, post links and insights where they are; the first business is told, and learns nothing of the second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShop, connectPage, hit, useWorld } from '../../p1/spec-p1/support.js';

const world = useWorld();

async function consent(shop, nextLogin = {}) {
  await world.meta.post('/facebook/login-next', nextLogin);
  const { authorizeUrl } = await shop.call('/facebook/connect', 200, { method: 'POST', body: {} });
  const answer = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(answer.headers.get('location'));
  const done = await hit(world, `${back.pathname}${back.search}`, { host: shop.host });
  return new URL(done.headers.location, 'http://x').searchParams.get('facebook');
}

async function historyOf(shop, pageId) {
  const count = async (sql) => Number((await shop.sql(sql, [shop.tenantId, pageId]))[0].n);
  return {
    jobs: await count('SELECT count(*) AS n FROM outbound_jobs WHERE tenant_id = $1 AND fb_page_id = $2'),
    threads: await count('SELECT count(*) AS n FROM inbox_threads WHERE tenant_id = $1 AND fb_page_id = $2'),
    links: await count('SELECT count(*) AS n FROM fb_post_links WHERE tenant_id = $1 AND fb_page_id = $2'),
    insights: await count(`SELECT count(*) AS n FROM analytics_accounts WHERE tenant_id = $1 AND channel = 'facebook' AND fb_page_id = $2`),
    page: await count('SELECT count(*) AS n FROM fb_pages WHERE tenant_id = $1 AND page_id = $2'),
  };
}

async function buildHistory(shop, pageId) {
  await shop.sql(
    `INSERT INTO outbound_jobs (tenant_id, channel, fb_page_id, kind, idempotency_key, status, recipient_id, expires_at, payload)
     VALUES ($1, 'facebook', $2, 'dm', 'history-1', 'sent', 'psid-1', now() + interval '1 day', '{"message":{"text":"hello"}}')`,
    [shop.tenantId, pageId],
  );
  await shop.sql(
    `INSERT INTO inbox_threads (tenant_id, channel, fb_page_id, subject_hash, recipient_id, last_message, last_message_at)
     VALUES ($1, 'facebook', $2, 'subject-fb-1', 'psid-1', 'hello', now())`,
    [shop.tenantId, pageId],
  );
  await shop.sql(`INSERT INTO fb_post_links (tenant_id, fb_page_id, fb_post_id, ig_media_id) VALUES ($1, $2, $2 || '_1', '17900000000000555')`, [shop.tenantId, pageId]);
  await shop.sql(`INSERT INTO analytics_accounts (tenant_id, channel, fb_page_id, collecting_since) VALUES ($1, 'facebook', $2, current_date)`, [shop.tenantId, pageId]);
}

test('tenancy-1: another business connecting a Facebook Page this business disconnected leaves this business\'s history in place', async () => {
  const a = await addShop(world);
  const { pageId } = await connectPage(world, a);
  await buildHistory(a, pageId);
  const before = await historyOf(a, pageId);
  assert.deepEqual(before, { jobs: 1, threads: 1, links: 1, insights: 1, page: 1 });
  assert.equal((await a.api('/facebook/connection', { method: 'DELETE' })).status, 204);

  const b = await addShop(world);
  assert.equal(await consent(b, { pageIds: [pageId] }), 'connected');

  assert.deepEqual(await historyOf(a, pageId), before, 'the first business keeps its inbox, send history, post links and insights');
  const live = await a.sql(`SELECT tenant_id FROM fb_pages WHERE page_id = $1 AND access_token_enc <> ''`, [pageId]);
  assert.deepEqual(live.map((r) => r.tenant_id), [b.tenantId], 'only the business that holds the Page now has a token for it');
  assert.equal((await b.call('/facebook/connection', 200)).status, 'active');
  assert.equal((await a.call('/facebook/connection', 200)).status, 'not_connected');

  const alerts = await a.sql(`SELECT kind, message, target FROM alerts WHERE tenant_id = $1 AND kind = 'facebook.connected_elsewhere'`, [a.tenantId]);
  assert.equal(alerts.length, 1, 'the first business is told');
  const audit = await a.sql(`SELECT actor, action, target, details FROM audit_log WHERE tenant_id = $1 AND action = 'facebook.connected_elsewhere'`, [a.tenantId]);
  assert.equal(audit.length, 1, 'and it is in its audit log');
  assert.doesNotMatch(JSON.stringify({ alerts, audit }), new RegExp(`${b.slug}|\\b${b.tenantId}\\b`), 'nothing about the other business is in what the first business sees');

  // The first business cannot take the Page back while the second holds it.
  assert.equal(await consent(a, { pageIds: [pageId] }), 'taken');
  assert.deepEqual(await historyOf(a, pageId), before);
});
