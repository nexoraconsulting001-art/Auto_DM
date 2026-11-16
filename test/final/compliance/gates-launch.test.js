// D-3: PRD 4.15's release gates are enforced when an automation goes to Test or Live, not only shown on the status page.
// C-52 and C-53 at the seller API, with the business's gates written the way ig-connect records them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, refused, withApp } from '../../p0/admin-api/support.js';
import { IG_ACCOUNT, passReleaseGates } from '../../helpers.js';

const body = (extra = {}) => ({ name: 'Diwali reel', triggerType: 'comment', keywords: ['price'], linkUrl: 'https://seller.test/p', triggers: [{ targetType: 'reel', mediaId: 'R1' }], variants: [{ label: 'A', body: 'Here it is' }], ...extra });
const draft = async (app, extra) => ok(await app.api('POST', '/automations', body(extra)), 201);
const goTo = (app, id, state) => app.api('POST', `/automations/${id}/state`, { state });
const settings = (app, fields) => app.db.platform.query(
  `UPDATE compliance_settings SET ${Object.keys(fields).map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE tenant_id = $1`,
  [app.tenant.id, ...Object.values(fields)],
);
const stateOf = async (app, id) => (await ok(await app.api('GET', `/automations/${id}`))).state;
const gateLog = async (app) => (await app.db.platform.query(`SELECT decision, reason FROM compliance_events WHERE tenant_id = $1 AND kind = 'gate' ORDER BY id`, [app.tenant.id]));

test('D-3: a business that has passed no release gate can put nothing on Test or Live, and the refusal names the gate', withApp({ releaseGates: false }, async (app) => {
  const auto = await draft(app);
  for (const state of ['live', 'test']) {
    const res = await refused(await goTo(app, auto.id, state), 400, 'validation_failed');
    assert.equal(res.reason, 'gate.access_level', state);
    assert.equal(await stateOf(app, auto.id), 'draft', `${state} left it a draft`);
  }
}));

test('D-3: each failing gate stops going live with its own code (C-52, C-53), and passing all of them is logged gate.passed', withApp({ releaseGates: false }, async (app) => {
  await passReleaseGates(app.db, app.tenant.id);
  const auto = await draft(app);

  await settings(app, { access_level: 'standard', app_role_ok: false });
  assert.equal((await refused(await goTo(app, auto.id, 'live'), 400, 'validation_failed')).reason, 'gate.access_level');
  await settings(app, { app_role_ok: true });

  await app.db.platform.query('UPDATE ig_accounts SET granted_scopes = $3 WHERE tenant_id = $1 AND ig_user_id = $2', [app.tenant.id, IG_ACCOUNT.igUserId, ['instagram_business_basic', 'instagram_business_manage_comments']]);
  assert.equal((await refused(await goTo(app, auto.id, 'live'), 400, 'validation_failed')).reason, 'gate.scope_missing');
  await passReleaseGates(app.db, app.tenant.id);

  // A health check counts while its last pass is recent; one that has not passed for over a day no longer does.
  await settings(app, { privacy_url_ok_at: new Date(Date.now() - 3 * 86_400_000) });
  assert.equal((await refused(await goTo(app, auto.id, 'live'), 400, 'validation_failed')).reason, 'gate.privacy_url');
  await settings(app, { privacy_url_ok_at: new Date(), deletion_callback_ok_at: null });
  assert.equal((await refused(await goTo(app, auto.id, 'live'), 400, 'validation_failed')).reason, 'gate.deletion_callback');
  assert.equal(await stateOf(app, auto.id), 'draft');

  await passReleaseGates(app.db, app.tenant.id);
  assert.equal((await ok(await goTo(app, auto.id, 'live'))).state, 'live');
  const log = await gateLog(app);
  assert.deepEqual(log.at(-1), { decision: 'gate.passed', reason: 'gate.passed' });
  assert.ok(log.some((row) => row.reason === 'gate.deletion_callback'), JSON.stringify(log));
}));

test('D-3: the gates are read for this business only: another business passing them does not let this one go live', withApp({ releaseGates: false }, async (app) => {
  const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
  await app.platform.tenants.linkIgAccount(other.id, 'IG-LEAF', 'leaf');
  await passReleaseGates(app.db, other.id, 'IG-LEAF');
  const auto = await draft(app);
  assert.equal((await refused(await goTo(app, auto.id, 'live'), 400, 'validation_failed')).reason, 'gate.access_level');
}));
