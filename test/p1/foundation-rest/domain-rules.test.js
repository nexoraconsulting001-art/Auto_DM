import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDomain, dnsRecords, edgeHost, isApex, isPlatformAddress, isReservedHost, siblingOf, toAsciiHost } from '../../../src/modules/domains/rules.js';
import { ValidationError } from '../../../src/util.js';

const config = { platformDomain: 'shops.example', platformHost: '' };

test('what a person types becomes one plain host', () => {
  assert.equal(toAsciiHost(' HTTP://Shop.Example.COM:443/a?b#c '), 'shop.example.com');
  assert.equal(toAsciiHost('shop.example.com.'), 'shop.example.com');
  assert.equal(toAsciiHost('https://'), '');
  assert.equal(toAsciiHost('a b.example'), '');
});

test('a domain has at least two real labels and a name-like ending', () => {
  for (const good of ['shop.example', 'a-b.c-d.example', 'xn--mnchen-3ya.example', `${'a'.repeat(63)}.example`]) assert.equal(cleanDomain(good, config), good);
  for (const bad of ['', 'one', '1.2.3.4', '1.2.3.999', 'a_b.example', `${'a'.repeat(64)}.example`, `${'a.'.repeat(130)}example`, 'x.onion', 'x.arpa']) {
    assert.throws(() => cleanDomain(bad, config), ValidationError, bad);
  }
});

test('the platform\'s own addresses can\'t be claimed', () => {
  assert.ok(isPlatformAddress('shops.example', config));
  assert.ok(isPlatformAddress('any.shops.example', config));
  assert.ok(!isPlatformAddress('shops.example.attacker.example', config));
  assert.ok(!isPlatformAddress('notshops.example', config));
  assert.ok(isPlatformAddress('ops.team.example', { platformDomain: 'shops.example', platformHost: 'ops.team.example' }));
});

test('every reserved label is reserved under the neutral domain, and nothing else is', () => {
  for (const label of ['bhava', 'www', 'app', 'api', 'admin', 'edge']) assert.ok(isReservedHost(`${label}.shops.example`, config), label);
  assert.ok(isReservedHost('shops.example', config));
  assert.ok(!isReservedHost('kesar.shops.example', config));
  assert.ok(!isReservedHost('admin.example', config));
  assert.ok(!isReservedHost('admin.example', { platformDomain: '', platformHost: '' }));
});

test('an apex is the registered name, including under two-part endings', () => {
  for (const apex of ['kesar.example', 'kesar.in', 'kesar.co.in', 'kesar.co.uk']) assert.ok(isApex(apex), apex);
  for (const sub of ['shop.kesar.example', 'shop.kesar.co.in', 'www.kesar.in']) assert.ok(!isApex(sub), sub);
});

test('www and the apex are each other\'s sibling; other names have none', () => {
  assert.equal(siblingOf('www.kesar.example'), 'kesar.example');
  assert.equal(siblingOf('kesar.example'), 'www.kesar.example');
  assert.equal(siblingOf('kesar.co.in'), 'www.kesar.co.in');
  assert.equal(siblingOf('shop.kesar.example'), '');
});

test('the records name only the seller and the neutral edge', () => {
  const edge = edgeHost(config);
  assert.equal(edge, 'edge.shops.example');
  assert.deepEqual(dnsRecords('shop.kesar.example', 'tok', edge), [
    { type: 'TXT', name: '_site-verification.shop.kesar.example', value: 'tok' },
    { type: 'CNAME', name: 'shop.kesar.example', value: edge },
  ]);
  assert.deepEqual(dnsRecords('kesar.example', 'tok', edge, ['203.0.113.1', '2001:db9::1']).slice(1), [
    { type: 'A', name: 'kesar.example', value: '203.0.113.1' },
    { type: 'AAAA', name: 'kesar.example', value: '2001:db9::1' },
  ]);
  assert.deepEqual(dnsRecords('kesar.example', 'tok', edge).slice(1), [{ type: 'CNAME', name: 'kesar.example', value: edge }], 'with no known address, the form DNS hosts flatten');
  assert.deepEqual(dnsRecords('old.kesar.example', '', edge).map((r) => r.type), ['CNAME'], 'a row added by hand has no token to show');
  assert.equal(edgeHost({ platformDomain: '' }), '');
});
