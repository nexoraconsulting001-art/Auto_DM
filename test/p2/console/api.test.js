// The requests the Phase 2 screens build, sent through the console's own API client to the real server: each must be accepted, and each
// refusal must be the one the screen expects. The simulators stand in for Meta and Google; nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPLORE_DIMENSION_NAMES, EXPLORE_METRIC_NAMES } from '../../../src/contracts/analytics.js';
import { createApiClient } from '../../../shared/api-client/index.js';
import { OVERRIDE_WORD, downloadBody, exploreBody, exploreForm, funnelBody, guardView, rangeFrom, tagsBody, thresholdsBody } from '../../../console/src/features/insights/shared/figures.js';
import { addP2Shop, dayAgo, unique, useP2World } from '../spec-p2/support.js';

const world = useP2World();
const names = { metricNames: [...EXPLORE_METRIC_NAMES], dimensionNames: [...EXPLORE_DIMENSION_NAMES] };

/** The client the console uses, signed in with a bearer token instead of the console's cookie. */
const clientFor = (token) => createApiClient({ baseUrl: `${world.base}/api/v1`, getToken: () => token });

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the API to refuse');
  return null;
}

test('the ranges and comparisons the screens send are accepted by insights, traffic and Account Health', async () => {
  const shop = await addP2Shop(world, { slug: `con-range-${unique()}` });
  await shop.setCollectingSince(dayAgo(200));
  await shop.seedDays('reach', { 3: 1200, 4: null, 5: 900 });
  const api = clientFor(shop.token);
  for (const query of [rangeFrom(new URLSearchParams('range=7')), rangeFrom(new URLSearchParams('range=90')), rangeFrom(new URLSearchParams('range=custom&from=2026-01-01&to=2026-01-31')), rangeFrom(new URLSearchParams('range=bogus'))]) {
    const account = await api.insights.account(query);
    assert.ok(Array.isArray(account.metrics), JSON.stringify(query));
    const traffic = await api.traffic.summary({ ...query, compare: 'previous' });
    assert.equal(traffic.source, 'bhava');
    await api.accountHealth.history(query);
  }
  const reach = (await api.insights.account({ range: '7' })).metrics.find((m) => m.metric === 'reach');
  const gap = reach.days.find((d) => d.state === 'no_data');
  assert.ok(gap, 'a day stored as null comes back as no data, which the screen shows as "No data"');
  assert.equal(gap.value, null);
});

test('N-51: the Explore question the screen opens with, and one with every part filled in, both run; and save, pin and land on Home', async () => {
  const shop = await addP2Shop(world, { slug: `con-explore-${unique()}` });
  await shop.seedSessions([{ count: 30, source: 'bio_link', city: 'Pune' }, { count: 20, source: 'whatsapp', city: 'Mumbai' }, { count: 4, source: 'direct', city: 'Pune' }]);
  const api = clientFor(shop.token);
  const opening = exploreBody(exploreForm({ metrics: ['sessions'], dimensions: ['source'], range: '28' }), names);
  const first = await api.explore.query(opening);
  assert.deepEqual(first.columns.map((c) => [c.metric, c.source]), [['sessions', 'bhava']]);
  assert.equal(first.totals.sessions.value, 54);

  const full = exploreBody({
    metrics: ['sessions', 'bounce_rate'],
    dimensions: ['source', 'city'],
    filters: [{ dimension: 'city', op: 'include', value: 'Pune' }, { dimension: 'source', op: 'exclude', value: 'direct' }],
    thresholds: [{ metric: 'sessions', op: 'gte', value: '1' }],
    range: '28',
    compare: 'previous',
    chart: 'bar',
    sortBy: 'sessions',
    sortDirection: 'asc',
  }, names);
  const answer = await api.explore.query(full);
  assert.equal(answer.totals.sessions.value, 30, 'N-52: Pune only, without direct');
  assert.equal(answer.totals.bounce_rate.lowVolume, false);
  assert.ok(answer.compareFrom, 'the comparison period came back');

  const view = await api.savedViews.create({ name: 'Pune without direct', visibility: 'team', definition: full });
  assert.deepEqual(exploreBody(exploreForm(view.definition), names), full, 'the saved view opens back as it was');
  await api.savedViews.pin(view.id);
  const cards = await api.dashboard.cards();
  assert.deepEqual(cards.items.map((card) => card.view.name), ['Pune without direct'], 'N-54: on Home');
  await api.savedViews.unpin(view.id);
  await api.savedViews.remove(view.id);
});

test('N-58: a funnel built in the form is saved, and a tier 2 business sees "Needs tier 3" on its add-to-cart step', async () => {
  const shop = await addP2Shop(world, { slug: `con-funnel-${unique()}`, plan: 't2' });
  const api = clientFor(shop.token);
  const { body } = funnelBody({ name: 'Cart path', steps: [{ kind: 'landing_view' }, { kind: 'page_view', page: '/r/sale' }, { kind: 'add_to_cart' }], countBy: 'session', windowMinutes: 1440 });
  const funnel = await api.funnels.create(body);
  assert.equal(funnel.name, 'Cart path');
  const results = await api.funnels.results(funnel.id, { ...rangeFrom(new URLSearchParams('')), compare: 'previous', breakdown: 'source' });
  const cart = results.steps.find((s) => s.kind === 'add_to_cart');
  assert.equal(cart.unavailable, true);
  assert.equal(cart.message, 'Needs tier 3');
  const changed = await api.funnels.update(funnel.id, funnelBody({ ...body, name: 'Renamed', windowMinutes: 30 }).body);
  assert.equal(changed.windowMinutes, 30);
  await api.funnels.remove(funnel.id);
});

test('thresholds and tags the owner saves are accepted; a manager is told "Owner only." where the screen offers nothing', async () => {
  const shop = await addP2Shop(world, { slug: `con-owner-${unique()}` });
  await shop.accountRef(); // Reach Guard has thresholds once insights are being collected for the account
  const owner = clientFor(shop.token);
  const status = await owner.reachGuard.status();
  const { body } = thresholdsBody({ reachDropPercent: '70', mediaDropPercent: '45', clearPercent: String(status.thresholds.clearPercent) }, status.thresholds);
  const saved = await owner.reachGuard.setThresholds(body);
  assert.equal(saved.thresholds.reachDropPercent, 70);
  assert.equal(saved.thresholds.mediaDropPercent, 45);

  const tags = await owner.tags.get();
  const update = tagsBody({ metaEnabled: true, pixelId: '123456789', capiToken: 'token-1234567890', ga4Enabled: true, measurementId: 'g-spec1234', apiSecret: 'secret-1234567890' }, tags); // secret-scan:allow (made-up fixture values)
  const after = await owner.tags.update(update.body);
  assert.equal(after.meta.enabled, true);
  assert.equal(after.meta.capiTokenSet, true);
  assert.equal(after.ga4.measurementId, 'G-SPEC1234');
  assert.equal(JSON.stringify(after).includes('token-1234567890'), false, 'a saved token never comes back');

  const manager = await shop.addManager();
  const asManager = clientFor(manager.token);
  for (const call of [() => asManager.reachGuard.setThresholds(body), () => asManager.tags.get(), () => asManager.apiKeys.list({})]) {
    const error = await refusal(call());
    assert.equal(error.status, 403);
    assert.equal(error.message, 'Owner only.');
  }
  assert.equal(guardView(await asManager.reachGuard.status(), { role: 'manager' }).canEditThresholds, false);
});

test('the override word the screen asks for is one the server accepts: with no drop in reach it is refused for that reason, not the word', async () => {
  const shop = await addP2Shop(world, { slug: `con-override-${unique()}` });
  const api = clientFor(shop.token);
  const wrong = await refusal(api.compliance.slowModeOverride({ confirmation: 'yes please' }));
  assert.equal(wrong.status, 400);
  const right = await refusal(api.compliance.slowModeOverride({ confirmation: OVERRIDE_WORD }));
  assert.equal(right.status, 409, right.message);
  assert.match(right.message, /drop in reach/);
  assert.equal(guardView(await api.reachGuard.status(), { role: 'owner' }).offerOverride, false, 'and the screen offered nothing to begin with');
});

test('N-81: each summary file the Reports screen offers is a request the API takes, or a part not built yet; never a malformed one', async () => {
  const shop = await addP2Shop(world, { slug: `con-files-${unique()}` });
  const api = clientFor(shop.token);
  for (const source of ['account_daily', 'media', 'story_finals', 'content_funnel', 'health_history']) {
    for (const format of ['csv', 'xlsx']) {
      try {
        const created = await api.downloads.create(downloadBody({ source, format, range: { from: '2026-10-01', to: '2026-10-31' } }));
        assert.equal(created.source, source);
        assert.equal(created.format, format);
      } catch (error) {
        assert.equal(error.status, 501, `${source} ${format}: ${error.status} ${error.message}`);
      }
    }
  }
});
