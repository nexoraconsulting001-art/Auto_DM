// PRD 6.11 on a running app: the FAQ, the settings (off until switched on with at least one FAQ entry), "Ask a test
// question" and the reply log, for one business at a time, with the real adapter talking to tools/sim/ai.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AiSettings, AiTestAnswer, FaqEntry } from '../../../src/contracts/api/addons.js';
import { withTenant } from '../../../src/tenancy.js';
import { createAi as createAiSim } from '../../../tools/sim/ai/index.mjs';
import { OWNER, startApp } from '../../helpers.js';

let sim;
before(async () => {
  sim = await createAiSim().start();
});
after(async () => {
  await sim?.close();
});

test('the seller API: FAQ, settings, a test question and the log, one business only, and nothing to the provider without the add-on', async () => {
  const app = await startApp({ overrides: { aiDriver: 'chat_completions', aiBaseUrl: `${sim.url}/v1`, aiApiKey: sim.token, aiModel: 'sim-model-1' } });
  try {
    await sim.post('/reset');
    const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();
    const call = async (method, path, body) => {
      const res = await fetch(`${app.base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const requests = async () => (await sim.get('/requests')).requests.length;
    assert.ok(app.ctx.inbound.listeners() >= 1, 'the module listens for DMs no rule answered');

    // Off by default, and it cannot be switched on without the add-on or without an FAQ entry.
    const first = await call('GET', '/ai-replies');
    assert.equal(first.status, 200);
    assert.deepEqual(AiSettings.parse(first.body), { enabled: false, threshold: 0.8, configured: true, faqCount: 0, canEnable: false });
    const unpaid = await call('PATCH', '/ai-replies', { enabled: true });
    assert.deepEqual([unpaid.status, unpaid.body.code], [403, 'plan.feature_off']);
    assert.equal((await call('POST', '/ai-replies/test', { question: 'how many days for delivery?' })).status, 403);
    assert.equal(await requests(), 0, 'no add-on, nothing sent to the provider');

    await withTenant(app.tenant, () => app.ctx.repos.entitlements.setOverride('ai_replies'));
    const empty = await call('PATCH', '/ai-replies', { enabled: true });
    assert.deepEqual([empty.status, empty.body.code], [400, 'validation_failed']);
    assert.ok(empty.body.fields.enabled);

    const created = await call('POST', '/faq', { question: 'How long does delivery take?', answer: 'Delivery in 3 to 5 days.' });
    assert.equal(created.status, 201);
    const entry = FaqEntry.parse(created.body);
    assert.deepEqual((await call('GET', '/faq')).body.items.map((f) => f.id), [entry.id]);
    const on = await call('PATCH', '/ai-replies', { enabled: true, threshold: 0.9 });
    assert.equal(on.status, 200);
    assert.deepEqual(AiSettings.parse(on.body), { enabled: true, threshold: 0.9, configured: true, faqCount: 1, canEnable: true });
    assert.equal((await call('PATCH', '/ai-replies', { threshold: 0.3 })).status, 400, 'the threshold has a floor');

    // A test question: the answer, its source and score, compared with this business's threshold. Nothing is queued.
    const asked = await call('POST', '/ai-replies/test', { question: 'how many days for delivery?' });
    assert.equal(asked.status, 200);
    assert.deepEqual(AiTestAnswer.parse(asked.body), { answer: 'Delivery in 3 to 5 days.', sources: [{ kind: 'faq', id: entry.id, label: 'How long does delivery take?' }], score: 0.93, threshold: 0.9, wouldSend: true, reason: '' });
    const refund = await call('POST', '/ai-replies/test', { question: 'I want a refund' });
    assert.deepEqual([refund.body.wouldSend, refund.body.reason], [false, 'ai.handoff']);
    assert.equal(await requests(), 1, 'the refund never reached the provider');
    const logged = await call('GET', '/ai-replies/log?limit=1');
    assert.equal(logged.status, 200);
    assert.equal(logged.body.items.length, 1);
    assert.ok(logged.body.nextCursor, 'pages');
    assert.deepEqual([logged.body.items[0].outcome, logged.body.items[0].question], ['test', 'I want a refund']);
    const next = await call('GET', `/ai-replies/log?limit=5&cursor=${logged.body.nextCursor}`);
    assert.deepEqual(next.body.items.map((i) => [i.outcome, i.answer]), [['test', 'Delivery in 3 to 5 days.']]);
    await withTenant(app.tenant, async () => {
      const [jobs] = await app.db.query('SELECT count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1', [app.tenant.id]);
      assert.equal(jobs.n, 0, 'a test question queues nothing');
      const [usage] = await app.db.query(`SELECT count(*)::int AS n FROM usage_events WHERE tenant_id = $1 AND meter = 'ai_units'`, [app.tenant.id]);
      assert.equal(usage.n, 1, 'the one answer the provider gave is metered once');
    });

    // Another business's FAQ entry cannot be seen, changed or removed from this one.
    const other = await app.platform.tenants.create({ slug: `ai-api-${process.pid}`, name: 'Other' });
    const [theirs] = await withTenant(other, () => app.db.query(`INSERT INTO faq_entries (tenant_id, question, answer) VALUES ($1, 'Their Q', 'Their secret answer') RETURNING id`, [other.id]));
    assert.equal((await call('PATCH', `/faq/${theirs.id}`, { answer: 'Hijacked' })).status, 404);
    assert.equal((await call('DELETE', `/faq/${theirs.id}`)).status, 404);
    assert.doesNotMatch(JSON.stringify((await call('GET', '/faq')).body), /Their secret answer/);
    const [kept] = await withTenant(other, () => app.db.query('SELECT answer FROM faq_entries WHERE tenant_id = $1 AND id = $2', [other.id, theirs.id]));
    assert.equal(kept.answer, 'Their secret answer');

    // Removing the last entry switches AI replies off; a lapsed add-on asks the provider nothing.
    assert.equal((await call('DELETE', `/faq/${entry.id}`)).status, 204);
    assert.equal((await call('GET', '/ai-replies')).body.enabled, false);
    await withTenant(app.tenant, () => app.ctx.repos.entitlements.setOverride('ai_replies', { enabled: false }));
    assert.equal((await call('POST', '/ai-replies/test', { question: 'how many days for delivery?' })).status, 403);
    assert.equal(await requests(), 1);
  } finally {
    app.close();
  }
});
