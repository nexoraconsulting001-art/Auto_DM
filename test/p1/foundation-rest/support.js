// What this track's tests share: a small DNS zone, and a world with a business already signed in.
import { addBusiness, api, need, signIn, startWorld } from '../../p0/spec-p0/support.js';
import { fakeMail, hooks } from '../../p0/spec-p0/surfaces.js';

export const EDGE_IP = '203.0.113.10';

/** Public DNS as a test needs it: nothing is there until published, and `calls` counts lookups. */
export function dnsZone() {
  const maps = { TXT: new Map(), CNAME: new Map(), A: new Map() };
  const answer = (type, name) => {
    zone.calls++;
    if (maps[type].has(name)) return maps[type].get(name);
    throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
  };
  const zone = {
    calls: 0,
    publish(records) {
      for (const r of records) {
        if (r.type === 'TXT') maps.TXT.set(r.name, [[r.value]]);
        if (r.type === 'CNAME') maps.CNAME.set(r.name, [r.value]);
        if (r.type === 'A') maps.A.set(r.name, [r.value]);
      }
    },
    unpublish(type, name) {
      maps[type].delete(name);
    },
    resolveTxt: async (name) => answer('TXT', name),
    resolveCname: async (name) => answer('CNAME', name),
    resolve4: async (name) => answer('A', name),
  };
  return zone;
}

/** One app, one signed-in business, and the calls a domain test repeats. */
export async function domainWorld(t, { edgeAddress } = {}) {
  const dns = dnsZone();
  if (edgeAddress) dns.publish([{ type: 'A', name: 'edge.shops.example', value: edgeAddress }]);
  const mail = fakeMail();
  const app = await startWorld(t, { overrides: { [hooks.dns]: dns, [hooks.mail]: mail } });
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const token = await signIn(app, shop);
  const on = (business, businessToken) => {
    const call = (path, options) => api(app, business, businessToken, path, options);
    const add = (domain) => call('/domains', { method: 'POST', body: { domain } });
    const added = async (domain) => need(await add(domain), 201, `Add ${domain}`).json();
    const check = (id) => call(`/domains/${id}/check`, { method: 'POST' });
    const primary = (domain) => call('/domains/primary', { method: 'PUT', body: { domain } });
    const remove = (id) => call(`/domains/${id}`, { method: 'DELETE' });
    const list = async () => need(await call('/domains'), 200, 'List domains').json().items;
    const verified = async (domain) => {
      const row = await added(domain);
      dns.publish(row.records);
      const checked = need(await check(row.id), 200, `Check ${domain}`).json();
      if (checked.status !== 'verified') throw new Error(`${domain} is ${checked.status}`);
      return row;
    };
    return { call, add, added, check, primary, remove, list, verified };
  };
  const other = async (slug, name) => {
    const business = await addBusiness(app, { slug, name });
    return { business, ...on(business, await signIn(app, business)) };
  };
  return { app, dns, mail, shop, token, ...on(shop, token), other };
}
