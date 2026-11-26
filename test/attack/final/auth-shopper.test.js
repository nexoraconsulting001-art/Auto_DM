// Final attack on shopper sign-in (PRD 9.3, S-07 to S-11): one code opens one session even when sent at once, wrong
// guesses sent together still get three tries between them, hostile input is a 400, the next address stays on the store,
// and a planted shopper cookie never becomes the session.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, world } from '../../p4/shoppers/support.js';

let w;
before(async () => {
  w = await world();
});
after(() => w?.close());

const send = (b, phone) => b.request('/api/store/otp/send', { method: 'POST', json: { phone, purpose: 'sign_in' } });
const verify = (b, body, query = '') => b.request(`/api/store/otp/verify${query}`, { method: 'POST', json: { purpose: 'sign_in', ...body } });
const clear = () => w.app.db.platform.query('DELETE FROM rate_limit_hits');
let n = 0;
const phone = () => `98${String(70_000_000 + n++).padStart(8, '0')}`;

test('the right code sent five times at once signs in once', async () => {
  await clear();
  const p = phone();
  assert.equal((await send(browser(w.app), p)).status, 200);
  const code = await w.lastCode(p);
  const answers = await Promise.all(Array.from({ length: 5 }, () => verify(browser(w.app), { phone: p, code })));
  assert.ok(answers.every((a) => a.status < 500), answers.map((a) => a.status).join(','));
  assert.equal(answers.filter((a) => a.status === 200).length, 1, answers.map((a) => a.status).join(','));
});

test('ten wrong codes sent at once kill the code; the right one is refused after them', async () => {
  await clear();
  const p = phone();
  assert.equal((await send(browser(w.app), p)).status, 200);
  const code = await w.lastCode(p);
  const wrong = Array.from({ length: 10 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
  const answers = await Promise.all(wrong.map((c) => verify(browser(w.app), { phone: p, code: c })));
  assert.ok(answers.every((a) => a.status === 400), answers.map((a) => a.status).join(','));
  const late = await verify(browser(w.app), { phone: p, code });
  assert.equal(late.status, 400, 'the right code after ten wrong ones');
});

test('hostile codes and numbers are a 400 and never a session or a 5xx', async () => {
  await clear();
  const p = phone();
  assert.equal((await send(browser(w.app), p)).status, 200);
  const code = await w.lastCode(p);
  const arabic = [...code].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
  const bodies = [
    { phone: p, code: Number(code) }, { phone: p, code: [code] }, { phone: p, code: `${code}\u0000` }, { phone: p, code: arabic },
    { phone: p, code: `0${code}` }, { phone: [p], code }, { phone: `${p}\u0000`, code }, { phone: 'x'.repeat(50_000), code }, { phone: p, code: '9'.repeat(400) },
  ];
  for (const body of bodies) {
    const res = await verify(browser(w.app), body);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body).slice(0, 60)} answered ${res.status}`);
  }
  for (const value of [`${p}\u0000`, '٩'.repeat(10), 'x'.repeat(50_000), 9876543210, null]) {
    const res = await send(browser(w.app), value);
    assert.ok(res.status >= 400 && res.status < 500, `send ${JSON.stringify(value).slice(0, 30)} answered ${res.status}`);
  }
});

test('after a code sign-in the next address stays on this store, whatever it is given', async () => {
  for (const next of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '/login?next=//evil.example']) {
    await clear();
    const p = phone();
    const b = browser(w.app);
    assert.equal((await send(b, p)).status, 200);
    const code = await w.lastCode(p);
    const res = await verify(b, { phone: p, code }, `?next=${encodeURIComponent(next)}`);
    assert.equal(res.status, 200, `${next}: ${res.status}`);
    const body = await res.json();
    assert.ok(typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//') && !body.next.includes('\\'), `${next} became ${body.next}`);
  }
});

test('a planted shopper cookie is replaced at sign-in and is never a session', async () => {
  await clear();
  const p = phone();
  const planted = 'planted-shopper-session-value-0123456789abcdef0123';
  const b = browser(w.app);
  b.cookies().set('_sid', planted);
  assert.equal((await send(b, p)).status, 200);
  const res = await verify(b, { phone: p, code: await w.lastCode(p) });
  assert.equal(res.status, 200);
  assert.notEqual(b.cookies().get('_sid'), planted, 'the sign-in kept the planted value');
  const other = browser(w.app);
  other.cookies().set('_sid', planted);
  const account = await other.request('/account', { redirect: 'manual' });
  assert.ok(account.status >= 300 || !/Signed in as/.test(await account.text()), 'the planted value is a session');
});
