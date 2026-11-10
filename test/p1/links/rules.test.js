// The pure link rules: linkProblem, directLink and what counts as a public address (PRD 4.11, 6.6, 8.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directLink, hostLinkType, isPublicAddress, isWhatsappLink, linkProblem } from '../../../src/modules/links/rules.js';

const blockedHosts = new Map([['bit.ly', 'shortener'], ['l.instagram.com', 'redirector'], ['evil.example', 'malware'], ['phish.example', 'phishing'], ['adult.example', 'adult']]);
const SAVED = '919876543210';
const problem = (url, whatsappNumber = SAVED) => linkProblem(url, { whatsappNumber, blockedHosts });

for (const [label, url] of [
  ['plain', 'https://bit.ly/x'], ['capitals', 'https://BIT.LY/x'], ['www', 'https://www.bit.ly/x'], ['the https port', 'https://bit.ly:443/x'], ['a trailing dot', 'https://bit.ly./x'],
  ['two trailing dots', 'https://bit.ly../x'], ['a credential before it', 'https://shop.example@bit.ly/x'], ['a full-width dot', 'https://bit。ly/x'], ['a redirector', 'https://l.instagram.com/?u=https://shop.example'],
]) {
  test(`C-38: a shortener with ${label} is link.shortener`, () => assert.equal(problem(url), 'link.shortener'));
}

for (const url of ['https://notbit.ly/x', 'https://bit.ly.shop.example/x', 'https://shop.example/bit.ly']) {
  test(`C-38: ${url} only looks like a shortener`, () => assert.equal(problem(url), null));
}

for (const [url, reason] of [
  ['https://evil.example/x', 'link.blocked'], ['https://a.b.evil.example/x', 'link.blocked'], ['https://phish.example/', 'link.blocked'], ['https://adult.example/', 'link.blocked'],
]) {
  test(`C-63: ${url} is ${reason}`, () => assert.equal(problem(url), reason));
}

for (const url of [
  'http://shop.example/x', 'HTTP://shop.example/x', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,hi', 'ftp://shop.example/x', 'file:///etc/passwd',
  '//shop.example/x', 'shop.example/x', 'https:shop.example/x', 'https:/shop.example/x', 'https:\\\\shop.example\\x', 'https://shop.example/a b', 'https://shop.example/a\tb', ' https://shop.example/x', 'https://shop.example/\ud800', '', null, undefined, 42,
]) {
  test(`C-65: ${JSON.stringify(url)} is link.scheme`, () => assert.equal(problem(url), 'link.scheme'));
}

test('a link that names one site before an @ and opens another is refused', () => {
  assert.equal(problem('https://shop.example@other.example/x'), 'link.scheme');
  assert.equal(problem('https://user:pass@shop.example/x'), 'link.scheme');
});

for (const url of [
  'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f.0.0.1/x', 'https://169.254.169.254/latest/', 'https://10.0.0.5/x', 'https://192.168.1.1/', 'https://100.64.0.1/', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[fe80::1]/',
  'https://localhost/x', 'https://admin.localhost/x', 'https://printer.local/x', 'https://db.internal/x', 'https://intranet/x',
]) {
  test(`K-04: ${url} isn't a public website, so it is link.blocked`, () => assert.equal(problem(url), 'link.blocked'));
}

test('C-39: the saved number is allowed in both forms, however it was saved', () => {
  for (const url of [`https://wa.me/${SAVED}`, `https://wa.me/${SAVED}/`, `https://wa.me/${SAVED}?text=Hello`, `https://api.whatsapp.com/send?phone=${SAVED}`, `https://api.whatsapp.com/send/?phone=${SAVED}&text=Hi`]) {
    assert.equal(problem(url), null, url);
    assert.equal(linkProblem(url, { whatsappNumber: '+91 98765 43210', blockedHosts }), null, url);
    assert.equal(isWhatsappLink(url), true, url);
  }
});

for (const url of [
  'https://wa.me/919999999999', 'https://wa.me/919876543210abc', 'https://wa.me/', 'https://wa.me/%39%31', 'https://wa.me/919876543210/x', 'https://api.whatsapp.com/send', 'https://api.whatsapp.com/send?phone=919999999999',
  'https://api.whatsapp.com/send?phone=919999999999&phone=919876543210', 'https://api.whatsapp.com/other?phone=919876543210', 'https://chat.whatsapp.com/invite', 'https://www.whatsapp.com/send?phone=919876543210', 'https://www.wa.me/919876543210',
]) {
  test(`C-40: ${url} is link.not_allowlisted`, () => assert.equal(problem(url), 'link.not_allowlisted'));
}

test('C-40: no saved number allows no WhatsApp link', () => {
  for (const whatsappNumber of ['', null, undefined, 'none']) assert.equal(linkProblem(`https://wa.me/${SAVED}`, { whatsappNumber, blockedHosts }), 'link.not_allowlisted');
});

test('linkProblem works with no context at all, and still refuses what it can see', () => {
  assert.equal(linkProblem('https://shop.example/x'), null);
  assert.equal(linkProblem('http://shop.example/x'), 'link.scheme');
  assert.equal(linkProblem(`https://wa.me/${SAVED}`), 'link.not_allowlisted');
});

for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
  test(`${address} is public`, () => assert.equal(isPublicAddress(address), true));
}
for (const address of ['0.0.0.1', '10.1.1.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::', 'nonsense', '']) {
  test(`${JSON.stringify(address)} is not public`, () => assert.equal(isPublicAddress(address), false));
}

// ---- directLink ----

const seller = (url, extra = {}) => directLink({ url, linkType: 'seller_site', channel: 'instagram', automationSlug: 'diwali', mediaId: '1790', variantLabel: 'B', utmEnabled: true, measurement: {}, ...extra });
const params = (url) => Object.fromEntries(new URL(url).searchParams);

test('A-32: a seller link gets the 4 tags, and utm_content names the reel', () => {
  assert.equal(seller('https://shop.example/p/1'), 'https://shop.example/p/1?utm_source=instagram&utm_medium=dm&utm_campaign=diwali&utm_content=1790');
});

test('A-32: with no reel, utm_content names the variant', () => {
  assert.equal(params(seller('https://shop.example/p', { mediaId: '' })).utm_content, 'B');
});

test('A-32: a tag with no value isn\'t added', () => {
  assert.deepEqual(Object.keys(params(seller('https://shop.example/p', { automationSlug: '', mediaId: '', variantLabel: '' }))), ['utm_source', 'utm_medium']);
});

test('A-32: tags already on the link win, even when empty or encoded', () => {
  const out = seller('https://shop.example/p?utm_source=news&utm%5Fmedium=mail&utm_campaign=');
  assert.deepEqual(new URL(out).searchParams.getAll('utm_source'), ['news']);
  assert.equal(params(out).utm_medium, 'mail');
  assert.equal(params(out).utm_campaign, '');
  assert.equal(params(out).utm_content, '1790');
});

test('A-32: everything else in the address stays exactly as written', () => {
  const start = 'https://Shop.Example/p/a%20b;x=1?z=1&a=%7E+b&&c#reviews?not=query';
  const out = seller(start);
  assert.equal(out, 'https://Shop.Example/p/a%20b;x=1?z=1&a=%7E+b&&c&utm_source=instagram&utm_medium=dm&utm_campaign=diwali&utm_content=1790#reviews?not=query');
});

test('A-32: a bare address and an empty query both take tags', () => {
  assert.equal(params(seller('https://shop.example')).utm_medium, 'dm');
  assert.equal(new URL(seller('https://shop.example/?')).searchParams.getAll('utm_medium').length, 1);
});

test('A-32: switched off, the link is untouched', () => assert.equal(seller('https://shop.example/p?a=1', { utmEnabled: false }), 'https://shop.example/p?a=1'));

test('PRD 6.6: Facebook links say so', () => assert.equal(params(seller('https://shop.example/p', { channel: 'facebook' })).utm_source, 'facebook'));

test('PRD 6.6: a Bhava-hosted page carries the UTM tags only', () => {
  const out = directLink({ url: 'https://leaf.shops.example/p/lamp', linkType: 'bhava_page', channel: 'instagram', automationSlug: 'a', mediaId: '1', utmEnabled: true, measurement: { amazonTag: 'x-21', subId: 'y' } });
  assert.deepEqual(Object.keys(params(out)), ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']);
});

test('values are encoded, so a slug or reel id can\'t add a parameter', () => {
  const out = seller('https://shop.example/p', { automationSlug: 'a&evil=1', mediaId: 'x#y' });
  assert.equal(params(out).utm_campaign, 'a&evil=1');
  assert.equal(params(out).utm_content, 'x#y');
  assert.equal(new URL(out).searchParams.has('evil'), false);
  assert.equal(new URL(out).hash, '');
});

test('a value that can\'t be encoded doesn\'t throw', () => assert.doesNotThrow(() => seller('https://shop.example/p', { mediaId: '\ud800' })));

const amazon = (url, amazonTag = 'shopa-21', linkType = 'amazon') => directLink({ url, linkType, channel: 'instagram', automationSlug: 'a', mediaId: '1', utmEnabled: true, measurement: { amazonTag } });

test('A-33: Amazon gets the tag and nothing else', () => {
  assert.equal(amazon('https://www.amazon.in/dp/B0?th=1&psc=1#x'), 'https://www.amazon.in/dp/B0?th=1&psc=1&tag=shopa-21#x');
});

test('A-33: the reel\'s tag replaces every tag already there, where the first one was', () => {
  assert.equal(amazon('https://www.amazon.in/dp/B0?a=1&tag=old-21&b=2&tag=older-21'), 'https://www.amazon.in/dp/B0?a=1&tag=shopa-21&b=2');
});

test('A-33: with no tag set the Amazon link is untouched, and gets no UTM tags', () => {
  assert.equal(amazon('https://www.amazon.in/dp/B0', null), 'https://www.amazon.in/dp/B0');
  assert.equal(amazon('https://www.amazon.in/dp/B0', null, 'seller_site'), 'https://www.amazon.in/dp/B0');
});

for (const url of ['https://www.amazon.in.evil.example/dp/1', 'https://amazon.in.evil/dp/1', 'https://notamazon.in/dp/1', 'https://shop.example/amazon.in']) {
  test(`A-33: ${url} is not given an Amazon tag`, () => {
    assert.equal(amazon(url), url);
    assert.equal(hostLinkType(url), null);
  });
}

for (const url of ['https://amazon.in/dp/1', 'https://www.amazon.com/dp/1', 'https://www.amazon.co.uk/dp/1', 'https://smile.amazon.in/dp/1', 'https://WWW.AMAZON.IN/dp/1']) {
  test(`A-33: ${url} is Amazon`, () => assert.equal(hostLinkType(url), 'amazon'));
}

test('A-33: a tag can\'t reach into the rest of the link', () => {
  const out = amazon('https://www.amazon.in/dp/B0', 'x&evil=1#f');
  assert.equal(params(out).tag, 'x&evil=1#f');
  assert.equal(new URL(out).searchParams.has('evil'), false);
  assert.equal(new URL(out).hash, '');
});

const affiliate = (measurement, url = 'https://store.example/item/5?id=9') => directLink({ url, linkType: 'affiliate', channel: 'instagram', automationSlug: 'a', mediaId: '1', utmEnabled: true, measurement });

test('A-34: a network\'s own sub-ID parameter is used, and no UTM tags', () => {
  assert.equal(affiliate({ subId: 'reel-c', network: 'vcommission' }), 'https://store.example/item/5?id=9&aff_sub=reel-c');
  assert.equal(affiliate({ subId: 'reel-c', network: 'CueLinks' }), 'https://store.example/item/5?id=9&subid=reel-c');
});

test('A-34: an unknown network gets the plain parameter, whatever it is called', () => {
  for (const network of ['someone', '', undefined, '__proto__', 'constructor']) assert.equal(params(affiliate({ subId: 'r', network })).subid, 'r', String(network));
});

test('A-34: an explicit parameter name is used only if it is a parameter name', () => {
  assert.equal(params(affiliate({ subId: 'r', subIdParam: 'click_id' })).click_id, 'r');
  const out = affiliate({ subId: 'r', subIdParam: 'x&evil=1' });
  assert.equal(params(out).subid, 'r');
  assert.equal(new URL(out).searchParams.has('evil'), false);
});

test('A-34: no sub-ID leaves the link alone', () => assert.equal(affiliate({}), 'https://store.example/item/5?id=9'));

test('C-39: a WhatsApp link carries no tags, whatever it was saved as', () => {
  for (const linkType of ['whatsapp', 'seller_site', 'bhava_page', 'affiliate']) assert.equal(directLink({ url: `https://wa.me/${SAVED}`, linkType, automationSlug: 'a', mediaId: '1', utmEnabled: true, measurement: { subId: 'r' } }), `https://wa.me/${SAVED}`, linkType);
});

test('a link saved as WhatsApp or Amazon that isn\'t one is left alone', () => {
  for (const linkType of ['whatsapp', 'amazon']) assert.equal(directLink({ url: 'https://shop.example/p', linkType, automationSlug: 'a', mediaId: '1', utmEnabled: true, measurement: { amazonTag: 'x' } }), 'https://shop.example/p');
});

test('an address the rules refuse is returned as it is, for the gate to refuse', () => {
  for (const url of ['javascript:alert(1)', 'http://shop.example/p', 'not a url']) assert.equal(seller(url), url);
});

test('C-62: no form of link ever gains a host of ours or a hop', () => {
  for (const [url, linkType] of [['https://shop.example/p', 'seller_site'], ['https://www.amazon.in/dp/1', 'amazon'], ['https://store.example/i', 'affiliate'], ['https://leaf.shops.example/p', 'bhava_page']]) {
    const out = directLink({ url, linkType, channel: 'instagram', automationSlug: 'a', mediaId: '1', utmEnabled: true, measurement: { amazonTag: 't-21', subId: 's' } });
    assert.equal(new URL(out).origin, new URL(url).origin);
    assert.equal(new URL(out).pathname, new URL(url).pathname);
    assert.doesNotMatch(out, /bhava/i);
  }
});
