import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { fakeNetwork } from '../../shell/testing.js';
import { FREE_SHOP, MANAGER, callsTo, minutesAgo, openAt, page, reset, screenText, staff, writes } from '../compliance/testing.js';
import compliance from '../compliance/index.js';
import home from '../home/index.js';
import automations from './index.js';

jest.setTimeout(30000);
beforeEach(reset);

const NOW = minutesAgo(5);
const STATUS = { paused: false, pausedBy: null, canResume: true, pauseStore: false, globalPause: false, reconnectNeeded: false, breaker: 'closed', slowMode: { active: false, until: null, canOverride: false }, heldJobs: 0, gates: [] };
const CONNECTION = { status: 'active', igUserId: '1784', username: 'kesarhome', loginKind: 'instagram', scopes: [], missingScopes: [], insightsGranted: true, tokenExpiresAt: null, health: 'ok', webhooksSubscribed: true };
const MEDIA = [
  { id: '1790001', type: 'reel', caption: 'Spice Box Diwali', permalink: 'https://www.instagram.com/reel/a', thumbnailUrl: '', postedAt: NOW, automationId: null },
  { id: '1790002', type: 'post', caption: 'Brass diya set', permalink: 'https://www.instagram.com/p/b', thumbnailUrl: '', postedAt: NOW, automationId: 77 },
];

function automation(overrides = {}) {
  return {
    id: 12, name: 'Diwali spice box', slug: 'diwali-spice-box', state: 'draft', triggerType: 'comment', matchMode: 'keywords', keywords: ['SPICE'], includeReactions: false, priority: 0,
    linkMode: 'two_tap', linkType: 'seller_site', linkUrl: 'https://kesar.example.com/spice', finalUrl: 'https://kesar.example.com/spice?utm_source=instagram', linkStatus: 'ok',
    tapButtonTitle: 'Send me the link', linkButtonTitle: 'Open the link', publicReplyEnabled: false, followupEnabled: false, followupDelayMinutes: 60, followupText: '', linkMessage: '',
    schedule: { startsAt: null, endsAt: null, dailyStart: null, dailyEnd: null, outsideHours: 'hold' }, dryRun: false,
    triggers: [{ id: 1, channel: 'instagram', targetType: 'reel', mediaId: '1790001', permalink: '', thumbnailUrl: '', caption: 'Spice Box Diwali' }],
    variants: [{ id: 3, label: 'A', body: 'Hi {first_name}! Here it is.', buttonTitle: '', fallbackText: '', weight: 1, quickReplies: [] }],
    winnerVariantId: null, warnings: [], createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function api(extra = {}) {
  const server = { saved: null };
  const routes = {
    'GET /compliance/status': () => STATUS,
    'GET /facebook/connection': () => ({ enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null }),
    'GET /instagram/connection': () => CONNECTION,
    'GET /instagram/media': () => page(MEDIA),
    'GET /automations': (call) => page([
      { id: 12, name: 'Diwali spice box', state: 'live', triggerType: 'comment', linkMode: 'two_tap', mediaCount: 1, sends: 412, updatedAt: NOW },
      { id: 13, name: 'Welcome', state: 'draft', triggerType: 'dm_welcome', linkMode: 'one_tap', mediaCount: 0, sends: 0, updatedAt: NOW },
    ].filter((row) => !call.search.includes('state=') || call.search.includes(`state=${row.state}`))),
    'POST /automations/preview': (call) => ({ filled: call.body.body.replaceAll('{first_name}', 'Asha'), withoutName: call.body.body.replaceAll('{first_name}', ''), bytes: call.body.body.length, maxBytes: 1000, problems: [] }),
    'POST /automations': (call) => {
      server.saved = automation({ ...call.body, id: 21, state: 'draft', triggers: call.body.triggers.map((t, i) => ({ id: i + 1, ...t })), variants: call.body.variants.map((v, i) => ({ id: i + 1, ...v })), schedule: call.body.schedule });
      return [201, server.saved];
    },
    'GET /automations/:id': (call) => (call.path.endsWith('/21') ? server.saved : automation()),
    'PATCH /automations/:id': (call) => automation({ ...call.body }),
    'POST /automations/:id/state': (call) => automation({ state: call.body.state }),
    'GET /automations/:id/stats': () => ({ automationId: 12, sends: 240, taps: 90, variants: [{ variantId: 3, label: 'A', sends: 120, taps: 50, visits: null, rate: 0.41, leader: true }, { variantId: 4, label: 'B', sends: 120, taps: 40, visits: null, rate: 0.33, leader: false }] }),
    'POST /automations/:id/winner': (call) => automation({ winnerVariantId: call.body.variantId }),
    'GET /testers': () => page([{ id: 5, channel: 'instagram', label: 'Asha’s phone', windowOpen: true, addedAt: NOW }, { id: 6, channel: 'instagram', label: '', windowOpen: false, addedAt: NOW }]),
    'POST /testers/codes': () => [201, { code: 'TEST-4821', expiresAt: minutesAgo(-30) }],
    'DELETE /testers/:id': () => null,
    'POST /automations/:id/send-test': () => ({ outcome: 'skipped', reason: 'window.closed' }),
    'GET /brand-kit': () => ({ publicReplyVariants: ['Sent!', 'Check your DMs'] }),
    'GET /measurement-ids': () => page([]),
    'POST /links/preview': (call) => ({ finalUrl: `${call.body.url}?utm_source=instagram`, linkType: 'seller_site', allowed: !call.body.url.includes('bit.ly'), reason: call.body.url.includes('bit.ly') ? 'link.shortener' : null, warnings: [] }),
    'GET /ice-breakers': () => ({ items: [{ question: 'Do you ship to Pune?', templateBody: 'Yes, across India.' }] }),
    'PUT /ice-breakers': (call) => call.body,
    ...extra,
  };
  return { server, routes };
}

async function open(path, { extra, ...options } = {}) {
  const { server: state, routes } = api(extra);
  const opened = await openAt(path, { list: [automations, compliance], routes, ...options });
  return { ...opened, state };
}

// ---- the list ----

test('the list shows each automation with its state and what it does, and filters by state', async () => {
  const { server } = await open('/automations');
  expect(await screen.findByTestId('automation-12')).toBeTruthy();
  expect(screen.getByText('Diwali spice box')).toBeTruthy();
  expect(screen.getByText(/1 posts, two taps, 412 DMs sent/)).toBeTruthy();
  expect(screen.getByText(/Welcome message, one tap, 0 DMs sent/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('automations-filter-draft'));
  await waitFor(() => expect(screen.queryByTestId('automation-12')).toBeNull());
  expect(server.calls.some((c) => c.path === '/automations' && c.search.includes('state=draft'))).toBe(true);
});

test('an empty list says how to start; a failed one says so with a retry, never a crash', async () => {
  await open('/automations', { extra: { 'GET /automations': () => page([]) } });
  expect(await screen.findByTestId('automations-empty')).toBeTruthy();
  expect(screen.getByTestId('automations-first')).toBeTruthy();
});

test('a refused list shows the plain words for it', async () => {
  await open('/automations', { extra: { 'GET /automations': () => [403, { error: 'Not on your plan', code: 'forbidden' }] } });
  expect(await screen.findByTestId('automations-error')).toBeTruthy();
  expect(screen.getByText('You don’t have access to this. Ask the owner of this business.')).toBeTruthy();
});

test('offline, the saved list stays with the offline banner and New is disabled', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/automations', { network });
  await screen.findByTestId('automation-12');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('automation-12')).toBeTruthy();
  expect(screen.getByTestId('automations-new').props.accessibilityState.disabled).toBe(true);
  expect(writes(server)).toEqual([]);
});

test('staff without the automations permission have no automations screen at all', async () => {
  await open('/automations', { user: staff(['orders']), list: [home, automations, compliance] });
  expect(await screen.findByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('screen-automations')).toBeNull();
});

// ---- the builder ----

test('a new automation is checked before it is sent: every problem at once, and no call', async () => {
  const { server } = await open('/automations/new');
  await fireEvent.press(await screen.findByTestId('builder-save'));
  expect(await screen.findByText('Give this automation a name')).toBeTruthy();
  expect(screen.getByText('Add at least one keyword')).toBeTruthy();
  expect(screen.getByText('Write the message')).toBeTruthy();
  expect(callsTo(server, 'POST', '/automations')).toEqual([]);
});

test('building one: pick the reel, a keyword, the message and the link; Save creates it once and opens it', async () => {
  const { server } = await open('/automations/new');
  await fireEvent.press(await screen.findByTestId('media-1790001'));
  expect(screen.getByTestId('media-1790002-in-use')).toBeTruthy();
  expect(screen.getByTestId('builder-name').props.value).toBe('Spice Box Diwali');
  await fireEvent.changeText(screen.getByTestId('builder-keywords-draft'), 'spice, diwali,');
  expect(screen.getByTestId('builder-keywords-remove-spice')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('builder-body'), 'Hi {first_name}! Here is the Spice Box.');
  await fireEvent.changeText(screen.getByTestId('builder-link-url'), 'https://kesar.example.com/spice');
  await fireEvent.press(screen.getByTestId('builder-dry-run'));
  expect(await screen.findByText('https://kesar.example.com/spice?utm_source=instagram', {}, { timeout: 3000 })).toBeTruthy();
  await fireEvent.press(screen.getByTestId('builder-save'));
  await waitFor(() => expect(callsTo(server, 'POST', '/automations')).toHaveLength(1));
  const [{ body }] = callsTo(server, 'POST', '/automations');
  expect(body).toMatchObject({ name: 'Spice Box Diwali', triggerType: 'comment', keywords: ['spice', 'diwali'], linkUrl: 'https://kesar.example.com/spice', dryRun: true, matchMode: 'keywords' });
  expect(body.triggers).toEqual([{ channel: 'instagram', targetType: 'reel', mediaId: '1790001', permalink: 'https://www.instagram.com/reel/a', thumbnailUrl: '', caption: 'Spice Box Diwali' }]);
  expect(await screen.findByTestId('builder-done')).toBeTruthy();
  expect(screen.getByText('Saved.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('builder-save'));
  await waitFor(() => expect(callsTo(server, 'PATCH', '/automations/21')).toHaveLength(1));
  expect(callsTo(server, 'POST', '/automations')).toHaveLength(1); // the second save changes it; it never makes another
});

test('the DM preview is the seller’s: their name, the server’s filled-in words, and the name-less version', async () => {
  await open('/automations/12');
  expect(await screen.findByTestId('builder-dm')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('builder-dm-text').props.children).toBe('Hi Asha! Here it is.'), { timeout: 3000 });
  expect(screen.getByTestId('builder-dm-noname').props.children).toBe('If we don’t have their name: Hi ! Here it is.');
  const preview = within(screen.getByTestId('builder-preview'));
  expect(preview.getAllByText('Alpha Traders').length).toBeGreaterThan(0);
  expect(preview.queryByText(/Bhava/i)).toBeNull();
});

test('going live asks first, saves, then moves it; the badge follows', async () => {
  const { server } = await open('/automations/12');
  await fireEvent.press(await screen.findByTestId('builder-move-live'));
  expect(await screen.findByText('Real followers will start getting this DM.')).toBeTruthy();
  expect(writes(server)).toEqual([]);
  await fireEvent.press(screen.getByTestId('builder-confirm-confirm'));
  await waitFor(() => expect(callsTo(server, 'POST', '/automations/12/state').map((c) => c.body)).toEqual([{ state: 'live' }]));
  expect(callsTo(server, 'PATCH', '/automations/12')).toHaveLength(1);
  expect(await screen.findByText('It’s live.')).toBeTruthy();
});

test('a save the compliance engine refuses shows the reason it gave, with its code, and the field it names', async () => {
  await open('/automations/12', {
    extra: { 'PATCH /automations/:id': () => [422, { error: 'The message names the platform', code: 'validation_failed', reason: 'content.bhava_promo', fields: { linkMessage: 'Take out the platform’s name.' } }] },
  });
  await fireEvent.press(await screen.findByTestId('builder-save'));
  expect(await screen.findByTestId('builder-refusal')).toBeTruthy();
  expect(screen.getByText(/The message named or linked to the platform that sends it\./)).toBeTruthy();
  expect(screen.getByTestId('builder-refusal-code')).toBeTruthy();
  expect(screen.getByText('Take out the platform’s name.')).toBeTruthy();
});

test('a link the rules refuse says why before it is saved', async () => {
  await open('/automations/12');
  await fireEvent.changeText(await screen.findByTestId('builder-link-url'), 'https://bit.ly/x1');
  expect(await screen.findByTestId('builder-link-refused', {}, { timeout: 3000 })).toBeTruthy();
  expect(screen.getByText('Short links that hide the destination aren’t allowed.')).toBeTruthy();
});

test('a schedule that can’t be read is caught on the phone', async () => {
  const { server } = await open('/automations/12');
  await fireEvent.changeText(await screen.findByTestId('builder-dailyStart'), '25:00');
  await fireEvent.changeText(screen.getByTestId('builder-dailyEnd'), '18:00');
  await fireEvent.press(screen.getByTestId('builder-save'));
  expect(await screen.findByText('Use a time like 09:00.')).toBeTruthy();
  expect(callsTo(server, 'PATCH', '/automations/12')).toEqual([]);
  await fireEvent.changeText(screen.getByTestId('builder-dailyStart'), '09:00');
  await fireEvent.press(screen.getByTestId('builder-save'));
  await waitFor(() => expect(callsTo(server, 'PATCH', '/automations/12')).toHaveLength(1));
  expect(callsTo(server, 'PATCH', '/automations/12')[0].body.schedule).toEqual({ startsAt: null, endsAt: null, dailyStart: '09:00', dailyEnd: '18:00', outsideHours: 'hold' });
});

test('one tap is not offered on the free plan', async () => {
  await open('/automations/12', { business: FREE_SHOP });
  expect(await screen.findByTestId('builder-one-tap-paid')).toBeTruthy();
  expect(screen.queryByTestId('builder-link-mode-one_tap')).toBeNull();
});

test('test mode: a test goes only to a tester in their window, and the answer gives the engine’s reason', async () => {
  const { server } = await open('/automations/12', { user: MANAGER });
  expect(await screen.findByTestId('tester-5')).toBeTruthy();
  expect(screen.getByText('Needs to message you first')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('send-test'));
  expect(await screen.findByTestId('send-test-result')).toBeTruthy();
  expect(screen.getByText(/It has been more than 24 hours since this person last m/)).toBeTruthy();
  expect(callsTo(server, 'POST', '/automations/12/send-test').map((c) => c.body)).toEqual([{ testerId: 5 }]);
  await fireEvent.changeText(screen.getByTestId('testers-label'), 'Ravi');
  await fireEvent.press(screen.getByTestId('testers-add'));
  expect(await screen.findByText('TEST-4821')).toBeTruthy();
  expect(callsTo(server, 'POST', '/testers/codes').map((c) => c.body)).toEqual([{ label: 'Ravi' }]);
});

test('staff can test but not add or remove testers, which are the owner’s and managers’', async () => {
  await open('/automations/12', { user: staff(['automations']) });
  expect(await screen.findByTestId('tester-5')).toBeTruthy();
  expect(screen.queryByTestId('testers-add')).toBeNull();
  expect(screen.queryByTestId('tester-5-remove')).toBeNull();
  expect(screen.getByTestId('send-test')).toBeTruthy();
});

test('the numbers mark the leader, and picking a winner is sent once', async () => {
  const { server } = await open('/automations/12');
  expect(await screen.findByTestId('stats-A-leader')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('stats-B-pick'));
  await waitFor(() => expect(callsTo(server, 'POST', '/automations/12/winner').map((c) => c.body)).toEqual([{ variantId: 4 }]));
});

test('offline, the builder shows what was saved and every change is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/automations/12', { network });
  await screen.findByTestId('builder-save');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  for (const id of ['builder-save', 'builder-move-live', 'builder-delete', 'send-test']) expect(screen.getByTestId(id).props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('builder-name').props.editable).toBe(false);
  expect(writes(server)).toEqual([]);
});

test('ice breakers: up to four questions, each with its answer, saved together', async () => {
  const { server } = await open('/automations/ice-breakers');
  expect(await screen.findByTestId('ice-0')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('ice-add'));
  await fireEvent.press(screen.getByTestId('ice-save'));
  expect(await screen.findByText('Write the question')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('ice-1-question'), 'Is COD available?');
  await fireEvent.changeText(screen.getByTestId('ice-1-answer'), 'Yes, on every order.');
  await fireEvent.press(screen.getByTestId('ice-save'));
  await waitFor(() => expect(callsTo(server, 'PUT', '/ice-breakers')).toHaveLength(1));
  expect(callsTo(server, 'PUT', '/ice-breakers')[0].body.items).toHaveLength(2);
  expect(await screen.findByTestId('ice-saved')).toBeTruthy();
});

test('nothing the builder draws for the shopper names the platform', async () => {
  await open('/automations/new');
  await screen.findByTestId('builder-preview');
  expect(within(screen.getByTestId('builder-preview')).queryByText(/Bhava/i)).toBeNull();
  expect(screenText(screen)).toContain('My store page'); // the link type, in the seller's words
});
