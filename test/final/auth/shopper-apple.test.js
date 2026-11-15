// auth-9 (PRD 4.8): the shopper app's Sign in with Apple spends its nonce, as the seller's does: a captured identity token
// and nonce open one shopper session, never a second.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { appWorld, guestApp, json } from '../../p6/shopper-api/support.js';

test('auth-9: a shopper\'s Apple identity token and nonce sign in once; the same pair again is refused', async () => {
  const apple = createApple({ audience: 'sim.apple.owner-app' });
  await apple.start();
  const w = await appWorld({ overrides: { appleKeysBaseUrl: apple.url } });
  try {
    const bundleId = `com.example.t${w.app.tenant.id}`;
    const ios = await guestApp(w, { platform: 'ios' });
    const nonce = crypto.randomBytes(16).toString('hex');
    const { identityToken } = await apple.post('/identity-token', { sub: 'apple-shopper-replay', nonce, aud: bundleId });
    const first = await json(await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, device: ios.device } }));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // The same token and nonce, replayed from another device.
    const other = await guestApp(w, { platform: 'ios' });
    // Counted once the second device has its own guest session.
    const before = await w.app.db.platform.query(`SELECT count(*)::int AS n FROM shopper_app_sessions WHERE tenant_id = $1`, [w.app.tenant.id]);
    const replay = await other.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, device: other.device } });
    assert.equal(replay.status, 401, 'a replayed Apple token opened another shopper session');
    const after = await w.app.db.platform.query(`SELECT count(*)::int AS n FROM shopper_app_sessions WHERE tenant_id = $1`, [w.app.tenant.id]);
    assert.equal(after[0].n, before[0].n, 'no new session row');

    // A fresh nonce with a fresh token still signs the same shopper in.
    const nonce2 = crypto.randomBytes(16).toString('hex');
    const again = await apple.post('/identity-token', { sub: 'apple-shopper-replay', nonce: nonce2, aud: bundleId });
    const second = await json(await other.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: again.identityToken, nonce: nonce2, device: other.device } }));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.shopper.id, first.body.shopper.id);
  } finally {
    await w.close();
    await apple.close();
  }
});
