// What the simulators gained for Phase 2: Meta's retention and request rules, Conversions API, and GA4 Measurement Protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashedUserData, createConversions } from '../../../src/adapters/meta/index.js';
import { Ga4Error, Ga4HostBlockedError, createGa4 } from '../../../src/adapters/google/index.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { createGoogle } from '../../../tools/sim/google/index.mjs';

const DAY = 86_400_000;
const ID = '1784';
const NOW = Date.parse('2026-11-10T12:00:00Z');

async function meta(t) {
  const sim = await createMeta().start();
  t.after(() => sim.close());
  await sim.post('/clock', { now: NOW, freeze: true });
  const { token } = await sim.post('/accounts', { igUserId: ID, username: 'shop' });
  const get = async (path, query = {}) => {
    const url = new URL(`/v23.0/${path}`, sim.url);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  return { sim, get };
}

const unix = (ms) => String(Math.floor(ms / 1000));

test('account insights older than 90 days are refused, and a range over 30 days too', async (t) => {
  const { get } = await meta(t);
  const old = await get(`${ID}/insights`, { metric: 'reach', period: 'day', since: unix(NOW - 91 * DAY), until: unix(NOW - 90 * DAY) });
  assert.match(old.body.error.message, /90 days/);
  const wide = await get(`${ID}/insights`, { metric: 'reach', period: 'day', since: unix(NOW - 40 * DAY), until: unix(NOW) });
  assert.match(wide.body.error.message, /30 days/);
});

test('impressions is refused by name', async (t) => {
  const { sim, get } = await meta(t);
  await sim.post('/media', { igUserId: ID, id: 'r1' });
  assert.match((await get('r1/insights', { metric: 'impressions' })).body.error.message, /impressions/);
  assert.match((await get(`${ID}/insights`, { metric: 'impressions', period: 'day' })).body.error.message, /impressions/);
});

test('media older than 2 years is no longer available', async (t) => {
  const { sim, get } = await meta(t);
  await sim.post('/media', { igUserId: ID, id: 'old', productType: 'FEED', mediaType: 'IMAGE', at: NOW - 731 * DAY });
  assert.match((await get('old/insights', { metric: 'reach' })).body.error.message, /no longer available/);
});

test('a metric with a breakdown must be asked alone', async (t) => {
  const { sim, get } = await meta(t);
  await sim.post('/media', { igUserId: ID, id: 'r1' });
  assert.match((await get('r1/insights', { metric: 'views,profile_activity', breakdown: 'action_type' })).body.error.message, /on its own/);
  assert.match((await get('r1/insights', { metric: 'profile_activity' })).body.error.message, /requires breakdown/);
});

test('a time series shows only the days that have data, with each day\'s end time', async (t) => {
  const { sim, get } = await meta(t);
  await sim.post('/insights/daily', { igUserId: ID, metric: 'reach', points: [{ day: '2026-11-05', value: 10 }, { day: '2026-11-06', value: null }] });
  const res = await get(`${ID}/insights`, { metric: 'reach', period: 'day', metric_type: 'time_series', since: unix(Date.parse('2026-11-05')), until: unix(Date.parse('2026-11-07')) });
  assert.deepEqual(res.body.data[0].values, [{ value: 10, end_time: '2026-11-06T00:00:00+0000' }]);
});

test('insightsDelayMs hides days younger than the delay', async (t) => {
  const { sim, get } = await meta(t);
  await sim.post('/limits', { insightsDelayMs: 2 * DAY });
  await sim.post('/insights/daily', { igUserId: ID, metric: 'reach', points: [{ day: '2026-11-09', value: 10 }] });
  const res = await get(`${ID}/insights`, { metric: 'reach', period: 'day', metric_type: 'total_value', since: unix(Date.parse('2026-11-09')), until: unix(Date.parse('2026-11-10')) });
  assert.deepEqual(res.body.data, []);
});

test('reset clears everything added for Phase 2', async (t) => {
  const { sim } = await meta(t);
  await sim.post('/pixels', { pixelId: '123456' });
  await sim.post('/reset');
  assert.deepEqual((await sim.get('/capi/events')).received, []);
});

// ---- Conversions API --------------------------------------------------------------------------------------------------

const event = (over = {}) => ({ event_name: 'Purchase', event_time: Math.floor(NOW / 1000), event_id: 'e1', action_source: 'website', user_data: hashedUserData({ email: ' A@B.com ' }), custom_data: { currency: 'INR', value: 100 }, ...over });

async function pixel(t) {
  const sim = await createMeta().start();
  t.after(() => sim.close());
  await sim.post('/clock', { now: NOW, freeze: true });
  const { token } = await sim.post('/pixels', { pixelId: '123456' });
  return { sim, conversions: createConversions({ graphBaseUrl: sim.url }), target: { pixelId: '123456', token } };
}

test('a server event and a browser hit with one event id count once (for N-69)', async (t) => {
  const { sim, conversions, target } = await pixel(t);
  assert.deepEqual(await conversions.send(target, [event()]), { received: 1, status: 200 });
  await fetch(`${sim.url}/tr?id=123456&ev=Purchase&eid=e1`);
  const { received, deduped } = await sim.get('/capi/events', { pixelId: '123456' });
  assert.equal(received.length, 2);
  assert.equal(deduped.length, 1);
});

test('a revoked token is a 190, and the token stays out of the address (for N-71)', async (t) => {
  const { sim, conversions, target } = await pixel(t);
  await sim.post('/pixels/revoke', { pixelId: '123456' });
  await assert.rejects(() => conversions.send(target, [event()]), (err) => err.kind === 'token_invalid');
  const [call] = await sim.calls({ path: '*/events' });
  assert.equal(call.query.access_token, undefined);
  assert.match(call.headers.authorization, /^Bearer /);
});

test('user data must be hashed, and an unhashed contact is refused', async (t) => {
  const { conversions, target } = await pixel(t);
  await assert.rejects(() => conversions.send(target, [event({ user_data: { email: 'a@b.com' } })]), (err) => err.kind === 'validation');
  await assert.rejects(() => conversions.send(target, [event({ user_data: { em: ['a@b.com'] } })]), (err) => err.kind === 'validation');
  await assert.rejects(() => conversions.send(target, [event({ event_time: Math.floor(NOW / 1000) - 8 * 86400 })]), (err) => err.kind === 'validation');
});

test('hashedUserData normalises before hashing and leaves out what it wasn\'t given', () => {
  assert.deepEqual(hashedUserData({ email: ' A@B.com ' }), hashedUserData({ email: 'a@b.com' }));
  assert.equal(hashedUserData({ phone: '+91 98765-43210' }).ph[0].length, 64);
  assert.deepEqual(hashedUserData({}), {});
});

// ---- GA4 ------------------------------------------------------------------------------------------------------------

async function ga4(t) {
  const sim = await createGoogle().start();
  t.after(() => sim.close());
  const { apiSecret } = await sim.post('/ga4/streams', { measurementId: 'G-ABC123' });
  return { sim, client: createGa4({ ga4BaseUrl: sim.url }), stream: { measurementId: 'G-ABC123', apiSecret } };
}

test('GA4 counts each purchase transaction once (for N-69)', async (t) => {
  const { sim, client, stream } = await ga4(t);
  const purchase = { name: 'purchase', params: { transaction_id: 'T1', value: 100, currency: 'INR' } };
  await client.send(stream, { clientId: 'c.1', events: [purchase] });
  await client.send(stream, { clientId: 'c.1', events: [purchase] });
  const events = await sim.get('/ga4/events', { measurementId: 'G-ABC123' });
  assert.equal(events.accepted.length, 2);
  assert.equal(events.purchases, 1);
});

test('like GA4, a bad secret still answers 2xx, and the event is dropped', async (t) => {
  const { sim, client, stream } = await ga4(t);
  assert.equal((await client.send({ ...stream, apiSecret: 'wrong' }, { clientId: 'c.1', events: [{ name: 'page_view' }] })).status, 204);
  const events = await sim.get('/ga4/events');
  assert.deepEqual([events.accepted.length, events.dropped.length], [0, 1]);
});

test('GA4 failures hold no secret, and only Google or a simulator can be the address', async (t) => {
  const { sim, client, stream } = await ga4(t);
  await sim.fault({ kind: 'server_error', status: 503, match: { path: '/mp/collect' } });
  await assert.rejects(() => client.send(stream, { clientId: 'c', events: [{ name: 'x' }] }), (err) => err instanceof Ga4Error && err.status === 503 && !err.message.includes(stream.apiSecret));
  assert.throws(() => createGa4({ ga4BaseUrl: 'https://evil.example' }, { env: {} }), Ga4HostBlockedError);
  assert.throws(() => createGa4({ ga4BaseUrl: sim.url }, { env: { NODE_ENV: 'production' } }), { code: 'ESIMREFUSED' });
  assert.doesNotThrow(() => createGa4({}, { env: { NODE_ENV: 'production' } }));
});
