// The pure rules: what a user agent says, where a session came from, and days in a business's time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayStart, lastYearOf, localParts, previousOf, rangeOf, sameSession } from '../../../src/modules/traffic/time.js';
import { pageOf, storablePath, isBuyerPage } from '../../../src/modules/traffic/page-kinds.js';
import { referrerDomainOf, sessionSource } from '../../../src/modules/traffic/source.js';
import { automatedKind, browserName, deviceType, inAppBrowser, operatingSystem } from '../../../src/modules/traffic/ua.js';
import { paiseOf, parseEarningsReport } from '../../../src/modules/traffic/destinations.js';
import { CHROME_UA, INSTAGRAM_UA, WHATSAPP_CRAWLER_UA } from './support.js';

test('a user agent is read into device, OS, browser and in-app, and link-preview crawlers are told apart', () => {
  assert.equal(inAppBrowser(INSTAGRAM_UA), 'instagram');
  assert.equal(deviceType(INSTAGRAM_UA), 'mobile');
  assert.equal(operatingSystem(INSTAGRAM_UA), 'Android');
  assert.equal(browserName(INSTAGRAM_UA), 'In-app');
  assert.equal(inAppBrowser('Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/1.0]'), 'facebook');
  assert.equal(browserName(CHROME_UA), 'Chrome');
  assert.equal(deviceType(CHROME_UA), 'desktop');
  assert.equal(automatedKind(WHATSAPP_CRAWLER_UA), 'crawler');
  assert.equal(automatedKind('facebookexternalhit/1.1'), 'crawler');
  assert.equal(automatedKind('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'bot');
  assert.equal(automatedKind(INSTAGRAM_UA), null);
  assert.equal(automatedKind('Mozilla/5.0 (Linux; Android 10; CUBOT X20) Chrome/100 Mobile'), null, 'a phone model is not a bot');
  assert.equal(automatedKind(''), null);
});

test('source: UTM tags first, then src, then the referrer, then direct', () => {
  assert.equal(sessionSource({ utm: { source: 'instagram', medium: 'dm' }, src: 'bio', referrerDomain: 'wa.me' }), 'instagram_comment_dm');
  assert.equal(sessionSource({ utm: { source: 'instagram', medium: 'dm' }, trigger: 'story_reply' }), 'story_reply');
  assert.equal(sessionSource({ utm: { source: 'facebook', medium: 'comment' } }), 'facebook_comment');
  assert.equal(sessionSource({ utm: {}, src: 'bio' }), 'bio_link');
  assert.equal(sessionSource({ utm: {}, src: 'nonsense', referrerDomain: 'l.instagram.com' }), 'bio_link');
  assert.equal(sessionSource({ utm: {}, referrerDomain: 'google.com' }), 'other_referrer');
  assert.equal(sessionSource({ utm: {} }), 'direct');
  assert.equal(sessionSource({ utm: {}, src: 'constructor' }), 'direct', 'a name every object inherits is not a source');
  assert.equal(referrerDomainOf('https://www.Example.com/a?b=1', 'shop.test'), 'example.com');
  assert.equal(referrerDomainOf('https://shop.test/x', 'shop.test'), '');
  assert.equal(referrerDomainOf('not a url', 'shop.test'), '');
});

test('days are in the business\'s zone, and a session ends at its midnight or after 30 quiet minutes', () => {
  const late = new Date('2026-11-05T19:00:00Z'); // 00:30 on the 6th in India
  assert.deepEqual(localParts(late, 'Asia/Kolkata'), { day: '2026-11-06', hour: 0, weekday: 5 });
  assert.equal(dayStart('2026-11-06', 'Asia/Kolkata').toISOString(), '2026-11-05T18:30:00.000Z');
  assert.equal(dayStart('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z');
  const t0 = new Date('2026-11-05T06:00:00Z');
  assert.equal(sameSession(t0, new Date(+t0 + 29 * 60_000), '2026-11-05', '2026-11-05'), true);
  assert.equal(sameSession(t0, new Date(+t0 + 30 * 60_000), '2026-11-05', '2026-11-05'), false);
  assert.equal(sameSession(t0, new Date(+t0 + 60_000), '2026-11-05', '2026-11-06'), false);
});

test('ranges and comparisons', () => {
  assert.deepEqual(rangeOf({ range: '7' }, '2026-11-05'), { since: '2026-10-30', until: '2026-11-05' });
  assert.deepEqual(rangeOf({ range: 'custom', from: '2026-01-01', to: '2026-01-31' }, '2026-11-05'), { since: '2026-01-01', until: '2026-01-31' });
  assert.deepEqual(previousOf({ since: '2026-11-01', until: '2026-11-07' }), { since: '2026-10-25', until: '2026-10-31' });
  assert.deepEqual(lastYearOf({ since: '2028-02-29', until: '2028-03-01' }), { since: '2027-02-28', until: '2027-03-01' });
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('which buyer page an address is, and that an order\'s token is never kept', () => {
  assert.deepEqual(pageOf('/r/brunch'), { kind: 'landing', ref: 'brunch' });
  assert.deepEqual(pageOf('/r/brunch/p/kurta'), { kind: 'product', ref: 'kurta' });
  assert.deepEqual(pageOf('/c/sarees'), { kind: 'category', ref: 'sarees' });
  assert.equal(pageOf('/order/abc').noTags, true);
  assert.equal(storablePath('/order/secret-token?x=1'), '/order');
  assert.equal(storablePath('/p/kurta?utm_source=a'), '/p/kurta');
  assert.equal(isBuyerPage('/admin/x'), false);
  assert.equal(isBuyerPage('/_t/s.js'), false);
  assert.equal(isBuyerPage('/r/x'), true);
});

test('an earnings report is read whatever comes before its header, and money never passes through a float', () => {
  assert.equal(paiseOf('₹1,234.50'), 123450);
  assert.equal(paiseOf('0.07'), 7);
  assert.equal(paiseOf('19.999'), 1999);
  assert.equal(paiseOf(''), null);
  const rows = parseEarningsReport('Fee-Earnings Report,,\nTracking ID,Date Shipped,Items Shipped,"Ad Fees"\nbrunch-21,2026-10-02,3,"1,250.00"\nother-21,2026-10-03,1,10\n');
  assert.deepEqual(rows[0], { tracking: 'brunch-21', day: '2026-10-02', earningsPaise: 125000, orders: 3 });
  assert.equal(rows.length, 2);
  assert.throws(() => parseEarningsReport('a,b\n1,2\n'), /tracking ID/);
});
