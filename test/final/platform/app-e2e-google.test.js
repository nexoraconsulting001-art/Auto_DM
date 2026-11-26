// Final loop 1 (Maestro owner P-11): the app's sign-in screen offers Google exactly when the server says Google sign-in
// is set up (app.requirements signIn.google). The emulator jobs' server (tools/app-e2e-server.mjs, which
// apps/owner/.maestro/support/server.mjs starts) pointed Google's keys at the simulator but gave it no seller client, so
// it said Google was off and the screen rightly left the button out. It now gets the simulator's own seller client.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoogleSellerSignIn } from '../../../src/adapters/google/index.js';
import { appRequirements } from '../../../src/modules/accounts/min-versions.js';
import { serverEnv } from '../../../tools/app-e2e-server.mjs';
import { SIM_SELLER_CLIENT } from '../../../tools/sim/google/index.mjs';

const urls = { meta: 'http://127.0.0.1:4101', whatsapp: 'http://127.0.0.1:4102', razorpay: 'http://127.0.0.1:4103', shiprocket: 'http://127.0.0.1:4104', shopify: 'http://127.0.0.1:4105', google: 'http://127.0.0.1:4106' };

test('the emulator server is given the Google simulator’s seller client, so its sign-in offers Google', async () => {
  const env = serverEnv({ urls, env: { PATH: '/usr/bin' } });
  assert.equal(env.GOOGLE_KEYS_BASE_URL, urls.google);
  assert.equal(env.SELLER_GOOGLE_CLIENT_ID, SIM_SELLER_CLIENT.id);
  assert.equal(env.SELLER_GOOGLE_CLIENT_SECRET, SIM_SELLER_CLIENT.secret);

  const signIn = createGoogleSellerSignIn({ sellerGoogleClientId: env.SELLER_GOOGLE_CLIENT_ID, sellerGoogleClientSecret: env.SELLER_GOOGLE_CLIENT_SECRET, googleKeysBaseUrl: env.GOOGLE_KEYS_BASE_URL }, { env: { NODE_ENV: 'development' } });
  assert.equal(signIn.configured, true);
  const answer = await appRequirements({ repos: { appVersions: { minimum: async () => null } }, notify: { channels: () => ({ whatsapp: true }) }, google: { signIn } })({ query: { app: 'owner', platform: 'android' } });
  assert.deepEqual(answer.signIn, { whatsapp: true, google: true, apple: false });
});

test('without a seller client the server says Google is off', async () => {
  const signIn = createGoogleSellerSignIn({ googleKeysBaseUrl: urls.google }, { env: { NODE_ENV: 'development' } });
  assert.equal(signIn.configured, false);
  const answer = await appRequirements({ repos: { appVersions: { minimum: async () => null } }, notify: { channels: () => ({ whatsapp: true }) }, google: { signIn } })({ query: { app: 'owner', platform: 'android' } });
  assert.equal(answer.signIn.google, false);
});
