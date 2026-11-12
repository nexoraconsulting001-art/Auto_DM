// The pure rules behind the console's Team, Devices, Notifications and sign-in screens (console/src/features/{team,devices,
// notifications,account}), held against the contract they mirror: the browser cannot import src/contracts where a file
// needs node, so every copied list, pattern and sentence is kept equal here, and every body a screen builds is parsed
// with the server's own schema. The last part asks the real app the questions the screens guess at. F-49, P-11.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import * as accounts from '../../../src/contracts/accounts.js';
import { NOTIFY_CHANNELS, NOTIFY_EVENTS, isLinkPath } from '../../../src/contracts/notifications.js';
import { NotificationPrefsInput, PERMISSIONS, QuietHours, SELLER_ROLES, TeamInviteInput, TeamUpdate } from '../../../src/contracts/api/index.js';
import * as team from '../../../console/src/features/team/rules.js';
import * as notes from '../../../console/src/features/notifications/rules.js';
import { describeDevice } from '../../../console/src/features/devices/rules.js';
import { waysIn } from '../../../console/src/features/account/signin.js';
import { OWNER, accountsApp, call, codeSignIn, freshCodes } from './support.js';

const member = (id, role, permissions = []) => ({ id, name: `P${id}`, role, permissions });

describe('Team', () => {
  test('roles and permissions are the contract\'s, in its order, each with words', () => {
    assert.deepEqual([...team.ROLES], [...SELLER_ROLES]);
    assert.deepEqual([...team.PERMISSIONS], [...PERMISSIONS]);
    for (const role of team.ROLES) assert.ok(team.ROLE_LABELS[role] && team.ROLE_HELP[role], role);
    for (const permission of team.PERMISSIONS) assert.ok(team.PERMISSION_LABELS[permission], permission);
  });

  test('F-49: the only owner is locked on the screen; with a second owner, or a list that may be missing people, nobody is', () => {
    const solo = [member(1, 'owner'), member(2, 'manager'), member(3, 'staff', ['orders'])];
    assert.equal(team.lastOwnerLock(solo[0], solo), team.LAST_OWNER);
    assert.equal(team.lastOwnerLock(solo[1], solo), '');
    assert.equal(team.lastOwnerLock(solo[0], solo, { complete: false }), '', 'an incomplete list rules nothing out: the server decides');
    const two = [member(1, 'owner'), member(2, 'owner')];
    assert.equal(team.lastOwnerLock(two[0], two), '');
    fc.assert(fc.property(fc.array(fc.constantFrom(...team.ROLES), { minLength: 1, maxLength: 12 }), (roles) => {
      const list = roles.map((role, i) => member(i + 1, role));
      const owners = roles.filter((role) => role === 'owner').length;
      return list.every((m) => Boolean(team.lastOwnerLock(m, list)) === (m.role === 'owner' && owners === 1));
    }));
  });

  test('a change sends only what changed, in a body the server takes, and nothing at all when nothing did', () => {
    const staff = member(4, 'staff', ['inbox', 'orders']);
    assert.equal(team.changeOf(staff, { role: 'staff', permissions: ['orders', 'inbox'] }), null, 'the same set in another order is no change');
    assert.deepEqual(team.changeOf(staff, { role: 'staff', permissions: ['inbox'] }), { permissions: ['inbox'] });
    assert.deepEqual(team.changeOf(staff, { role: 'manager', permissions: ['inbox'] }), { role: 'manager' }, 'permissions count only for staff');
    assert.deepEqual(team.changeOf(member(5, 'manager'), { role: 'staff', permissions: ['customers', 'catalog'] }), { role: 'staff', permissions: ['catalog', 'customers'] });
    fc.assert(fc.property(
      fc.constantFrom(...team.ROLES), fc.subarray([...team.PERMISSIONS]), fc.constantFrom(...team.ROLES), fc.subarray([...team.PERMISSIONS]),
      (fromRole, fromPermissions, toRole, toPermissions) => {
        const body = team.changeOf(member(6, fromRole, fromPermissions), { role: toRole, permissions: toPermissions });
        return body === null || TeamUpdate.safeParse(body).success;
      },
    ));
  });

  test('an invitation is checked the way the server reads the contact, and its body is one the server takes', () => {
    for (const ok of ['9876543210', '98765 43210', '+14155550100', '0044 20 7946 0958', 'asha@example.com', '  ASHA@Example.COM ']) {
      assert.deepEqual(team.inviteProblems({ contact: ok, role: 'manager', permissions: [] }), {}, ok);
      assert.ok(TeamInviteInput.safeParse({ contact: ok.trim(), role: 'manager', permissions: [] }).success, ok);
    }
    for (const bad of ['', '12345', '1234567890', '+0123456789', 'asha@example', 'asha example.com', '@example.com']) {
      assert.equal(team.inviteProblems({ contact: bad, role: 'manager' }).contact, 'Enter a phone number or an email', bad);
    }
    assert.equal(team.inviteContact('9876543210').subject, accounts.toE164('9876543210'));
    assert.deepEqual(team.inviteProblems({ contact: '9876543210', role: 'staff', permissions: [] }), { permissions: 'Choose at least one thing they can do' });
    assert.deepEqual(team.inviteProblems({ contact: '9876543210', role: 'boss' }), { role: 'Choose a role' });
  });

  test('what someone can do, in words', () => {
    assert.equal(team.permissionSummary(member(1, 'staff', ['inbox', 'orders'])), 'Orders, Inbox');
    assert.match(team.permissionSummary(member(1, 'staff', [])), /open nothing/);
    assert.equal(team.permissionSummary(member(1, 'owner')), team.ROLE_HELP.owner);
  });
});

describe('Notifications', () => {
  test('the switchable channels are the contract\'s, less in-app, which is always on', () => {
    assert.deepEqual([...notes.CHANNELS], NOTIFY_CHANNELS.filter((c) => c !== 'inapp'));
    for (const channel of notes.CHANNELS) assert.ok(notes.CHANNEL_LABELS[channel], channel);
  });

  test('quiet hours: the same clock as the contract, crossing midnight allowed, the same time twice refused', () => {
    const clock = QuietHours.shape.from;
    fc.assert(fc.property(fc.string({ maxLength: 6 }), (value) => notes.CLOCK.test(value) === clock.safeParse(value).success));
    for (const h of ['00:00', '07:30', '22:00', '23:59']) assert.ok(notes.CLOCK.test(h) && clock.safeParse(h).success, h);
    assert.deepEqual(notes.quietHoursProblems({ enabled: true, from: '22:00', to: '07:00' }), {});
    assert.deepEqual(notes.quietHoursProblems({ enabled: true, from: '22:00', to: '22:00' }), { to: 'Choose a different time from the start' });
    assert.deepEqual(notes.quietHoursProblems({ enabled: false, from: '22:00', to: '22:00' }), {}, 'switched off, the times are only kept');
    assert.deepEqual(notes.quietHoursProblems({ enabled: true, from: '7:00', to: '24:00' }), { from: 'Use a time such as 22:00', to: 'Use a time such as 07:00' });
    assert.match(notes.quietHoursText({ enabled: true, from: '22:00', to: '07:00' }), /from 22:00 to 07:00 the next morning/);
    assert.doesNotMatch(notes.quietHoursText({ enabled: true, from: '13:00', to: '15:00' }), /next morning/);
    assert.match(notes.quietHoursText({ enabled: false, from: '22:00', to: '07:00' }), /^Off/);
    const form = { enabled: true, from: '23:00', to: '06:30', timezone: 'Asia/Kolkata' };
    assert.ok(NotificationPrefsInput.safeParse({ quietHours: form }).success);
  });

  test('time zones offered always hold the saved one and India\'s, once each', () => {
    const zones = notes.timezoneChoices('Europe/London');
    assert.ok(zones.includes('Europe/London') && zones.includes('Asia/Kolkata'));
    assert.equal(new Set(zones).size, zones.length);
    assert.deepEqual(notes.timezoneChoices('Asia/Kolkata', { supportedValuesOf() { throw new Error('old browser'); } }), ['Asia/Kolkata']);
  });

  test('one switch is one body the server takes, and the screen shows it at once', () => {
    for (const [kind, spec] of Object.entries(NOTIFY_EVENTS)) {
      for (const channel of notes.CHANNELS) {
        const body = notes.choiceBody(kind, channel, !spec.channels.includes(channel));
        assert.ok(NotificationPrefsInput.safeParse(body).success, `${kind} ${channel}`);
      }
    }
    const prefs = { events: { 'order.new': { push: true, email: true }, 'token.invalid': { whatsapp: true } } };
    const next = notes.withChoice(prefs, 'order.new', 'email', false);
    assert.deepEqual(next.events['order.new'], { push: true, email: false });
    assert.equal(next.events['token.invalid'], prefs.events['token.invalid']);
    assert.equal(prefs.events['order.new'].email, true, 'the saved choices are not changed in place');
  });

  test('a notification opens a console page only for a path the contract allows and the console has', () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }).map((s) => `/${s}`), (link) => notes.linkInConsole(link) === null || isLinkPath(link)));
    assert.equal(notes.linkInConsole('/'), null, 'the list itself');
    assert.equal(notes.linkInConsole('//evil.example'), null);
    assert.equal(notes.linkInConsole('https://evil.example/x'), null);
    assert.equal(notes.linkInConsole('/orders/12', ['orders', 'orders/:id']), '/orders/12');
    assert.equal(notes.linkInConsole('/settings/instagram', ['settings', 'settings/team']), null);
    assert.equal(notes.pathMatches('orders/:id', '/orders/12'), true);
    assert.equal(notes.pathMatches('orders/:id', '/orders'), false);
    assert.equal(notes.pathMatches('orders/:id', '/orders/12/files'), false);
    assert.equal(notes.pathMatches('settings/*', '/settings/a/b'), true);

    // The pages the server's account notices link to are this track's, and the console has them.
    const pages = consolePages();
    for (const kind of ['staff.changed', 'device.signed_in', 'account.deletion_requested']) {
      const link = NOTIFY_EVENTS[kind].link;
      assert.equal(notes.linkInConsole(link, pages), link, kind);
    }
  });

  test('"5 min ago" and the like', () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    assert.equal(notes.whenText(new Date(now - 10_000).toISOString(), now), 'Just now');
    assert.equal(notes.whenText(new Date(now - 5 * 60_000).toISOString(), now), '5 min ago');
    assert.equal(notes.whenText(new Date(now - 3 * 3600_000).toISOString(), now), '3 h ago');
    assert.equal(notes.whenText(new Date(now - 30 * 3600_000).toISOString(), now), 'Yesterday');
    assert.match(notes.whenText(new Date(now - 5 * 86400_000).toISOString(), now), /Nov/);
  });
});

/** Every route path a console feature registers, read from its index.jsx as the parity check reads it. */
function consolePages() {
  const root = path.resolve(import.meta.dirname, '../../../console/src/features');
  return fs.readdirSync(root).flatMap((name) => {
    const file = path.join(root, name, 'index.jsx');
    if (!fs.existsSync(file)) return [];
    return [...fs.readFileSync(file, 'utf8').matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
  });
}

describe('Devices', () => {
  test('a device is named by what the person called it, else its platform, with the app and version for a phone', () => {
    assert.deepEqual(describeDevice({ name: 'Pixel 8', platform: 'android', app: 'owner', appVersion: '1.2.0' }), { name: 'Pixel 8', kind: 'Android phone', detail: 'Bhava for Business 1.2.0' });
    assert.deepEqual(describeDevice({ name: '', platform: 'ios', app: 'owner', appVersion: '' }), { name: 'iPhone', kind: '', detail: 'Bhava for Business' });
    assert.deepEqual(describeDevice({ name: 'Chrome on Android', platform: 'web', app: 'owner', appVersion: '' }), { name: 'Chrome on Android', kind: 'Web browser', detail: '' });
    assert.equal(describeDevice({ name: '  ', platform: 'web' }).name, 'Web browser');
  });
});

describe('Sign-in: what the page offers', () => {
  test('P-11: WhatsApp unless the server says no; Google only where it starts; a password only off the sign-in host; never SMS', () => {
    const requirements = { signIn: { whatsapp: true, google: true, apple: false } };
    assert.deepEqual(waysIn({ passwordRoute: false, requirements, signInHost: true }), { whatsapp: true, google: true, password: false, signInHost: true });
    assert.deepEqual(waysIn({ passwordRoute: true, requirements, signInHost: true }), { whatsapp: true, google: true, password: false, signInHost: true }, 'a password could never name a business on the sign-in host');
    assert.deepEqual(waysIn({ passwordRoute: true, requirements, signInHost: false }), { whatsapp: true, google: false, password: true, signInHost: false });
    assert.deepEqual(waysIn({ passwordRoute: false, requirements: null, signInHost: false }), { whatsapp: true, google: false, password: false, signInHost: false }, 'nothing learned: the code is still the way in');
    assert.equal(waysIn({ requirements: { signIn: { whatsapp: false, google: false } } }).whatsapp, false);
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (password, signInHost, google, whatsapp) => {
      const ways = waysIn({ passwordRoute: password, requirements: { signIn: { whatsapp, google } }, signInHost });
      return Object.keys(ways).every((key) => ['whatsapp', 'google', 'password', 'signInHost'].includes(key)) && !(ways.password && ways.signInHost) && !(ways.google && !signInHost);
    }));
  });
});

describe('against the app', () => {
  let app;
  before(async () => {
    app = await accountsApp();
  });
  after(() => app?.close());

  test('F-49: the sentence the screen shows before trying is the one the server answers with', async () => {
    await freshCodes(app);
    const owner = await codeSignIn(app, { phone: OWNER.phone });
    for (const [method, body] of [['PATCH', { role: 'manager' }], ['DELETE', undefined]]) {
      const res = await call(app, `/api/v1/team/${owner.user.id}`, { method, body, headers: owner.auth });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.error, team.LAST_OWNER);
    }
  });

  test('an invitation the screen lets through, the server takes; one it stops, the server refuses on the same field', async () => {
    await freshCodes(app);
    const owner = await codeSignIn(app, { phone: OWNER.phone });
    const samples = ['8765432109', '87654 32108', '+14155550123', 'meera@example.com', '  RAVI@Example.COM ', '12345678', '1234567890', '+0123456789', 'meera@example', 'meera example.com'];
    for (const contact of samples) {
      const body = { contact: contact.trim(), role: 'manager', permissions: [] };
      const res = await call(app, '/api/v1/team/invites', { method: 'POST', body, headers: owner.auth });
      const screen = team.inviteProblems({ contact, role: 'manager', permissions: [] });
      if (screen.contact) {
        assert.equal(res.status, 400, `${contact}: ${res.text}`);
        assert.equal(res.json.fields.contact, screen.contact, contact);
      } else {
        assert.equal(res.status, 201, `${contact}: ${res.text}`);
      }
    }
  });
});
