// Final review, buyer-1: a buyer page's Content-Security-Policy names another site only when that page asked for it, and only
// as a plain https origin, so nothing a page passes can widen the policy beyond the origins it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSecurityPolicy } from '../../../src/modules/traffic/tags.js';
import { GATEWAY_ORIGINS } from '../../../src/modules/storefront/views/pay.js';

const policy = (header) => Object.fromEntries(header.split(';').map((p) => p.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

test('buyer-1: a page with no sources keeps the default policy, with no frame-src and no gateway', () => {
  const p = policy(contentSecurityPolicy());
  assert.deepEqual(p['default-src'], ["'self'"]);
  assert.deepEqual(p['script-src'], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(p['connect-src'], ["'self'"]);
  assert.equal(p['frame-src'], undefined);
});

test('buyer-1: the payment pages’ sources let the gateway’s script, frame and calls through', () => {
  const p = policy(contentSecurityPolicy(undefined, GATEWAY_ORIGINS));
  for (const o of GATEWAY_ORIGINS.script) assert.ok(p['script-src'].includes(o), o);
  for (const o of GATEWAY_ORIGINS.frame) assert.ok(p['frame-src'].includes(o), o);
  for (const o of GATEWAY_ORIGINS.connect) assert.ok(p['connect-src'].includes(o), o);
  assert.deepEqual(p['default-src'], ["'self'"], 'default-src must stay self');
  assert.deepEqual(p['frame-ancestors'], ["'self'"]);
});

test('buyer-1: anything but a plain https origin is dropped from the sources', () => {
  const header = contentSecurityPolicy(undefined, {
    script: ['https://ok.example', 'https://x.example; script-src *', "'unsafe-eval'", '*', 'http://plain.example', 'https://*.example', 'https://a.example/path', 'data:', 42, null],
    frame: 'https://not-a-list.example',
    connect: ['https://ok.example', 'https://ok.example'],
  });
  const p = policy(header);
  assert.deepEqual(p['script-src'], ["'self'", "'unsafe-inline'", 'https://ok.example']);
  assert.equal(p['frame-src'], undefined);
  assert.deepEqual(p['connect-src'], ["'self'", 'https://ok.example']);
  assert.ok(!header.includes('unsafe-eval') && !header.includes('*') && !header.includes('http://'), header);
});
