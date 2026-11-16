// Attack: business separation through web addresses (PRD 5.2, 5.4). A business must never be able to take an address the
// platform itself answers on, nor keep another business from proving its own domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMail, hooks } from '../../p0/spec-p0/surfaces.js';
import { dnsZone } from '../../p1/foundation-rest/support.js';
import { addBusiness, api, hit, signIn, startWorld } from '../../p0/spec-p0/support.js';

const APP_HOST = 'app.sellers-hub.example';
const CALLBACK = 'https://hooks.sellers-hub.example';

async function world(t) {
  const dns = dnsZone();
  const app = await startWorld(t, { overrides: { [hooks.dns]: dns, [hooks.mail]: fakeMail(), platformAppHost: APP_HOST, metaCallbackBaseUrl: CALLBACK } });
  const make = async (slug, name) => {
    const business = await addBusiness(app, { slug, name });
    const token = await signIn(app, business);
    const call = (path, options) => api(app, business, token, path, options);
    return { business, token, call, add: (domain) => call('/domains', { method: 'POST', body: { domain } }), check: (id) => call(`/domains/${id}/check`, { method: 'POST' }) };
  };
  return { app, dns, make };
}

test('tenancy attack: a business cannot claim the host sellers sign in on, or the platform\'s callback host, as its custom domain', async (t) => {
  const { app, dns, make } = await world(t);
  const thief = await make('thief', 'Thief Traders');
  const taken = [];
  for (const host of [APP_HOST, new URL(CALLBACK).host]) {
    const res = await thief.add(host);
    if (res.status === 201) {
      // With the DNS proof in place (as whoever controls DNS there could do), the address would route to this business.
      dns.publish(res.json().records);
      const checked = await thief.check(host);
      const page = await hit(app, '/', { host });
      taken.push(`${host}: add 201, check ${checked.status} ${checked.text.slice(0, 80)}, GET / on it -> ${page.status}`);
    }
  }
  assert.deepEqual(taken, [], `a business claimed a platform host:\n${taken.join('\n')}`);
});

test('tenancy attack: another business adding the same pending domain cannot stop its rightful owner from verifying it', async (t) => {
  const { dns, make } = await world(t);
  const owner = await make('kesar-home', 'Kesar Home');
  const thief = await make('thief', 'Thief Traders');
  const domain = 'shop.kesarhome.example';
  const mine = await owner.add(domain);
  assert.equal(mine.status, 201, mine.text.slice(0, 200));
  dns.publish(mine.json().records); // the rightful owner has put its proof in DNS
  const squat = await thief.add(domain); // the thief, who controls no DNS here, adds the same name
  assert.ok(squat.status < 500, `${squat.status} ${squat.text.slice(0, 200)}`);
  const checked = await owner.check(domain);
  assert.equal(checked.status, 200, `the owner whose proof is in DNS can no longer check its domain: ${checked.status} ${checked.text.slice(0, 200)}`);
  assert.equal(checked.json().status, 'verified');
});
