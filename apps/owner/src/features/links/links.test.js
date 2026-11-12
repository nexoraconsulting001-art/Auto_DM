import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { fakeNetwork } from '../../shell/testing.js';
import { callsTo, minutesAgo, openAt, page, reset, staff, writes } from '../compliance/testing.js';
import home from '../home/index.js';
import links from './index.js';

jest.setTimeout(30000);
beforeEach(reset);

function routes(extra = {}) {
  return {
    'POST /links/preview': (call) => (call.body.url.includes('bit.ly')
      ? { finalUrl: call.body.url, linkType: 'seller_site', allowed: false, reason: 'link.shortener', warnings: [] }
      : { finalUrl: `${call.body.url}?utm_source=instagram&utm_medium=dm`, linkType: 'seller_site', allowed: true, reason: null, warnings: [] }),
    'POST /links/check': (call) => ({ ok: !call.body.url.includes('broken'), reason: call.body.url.includes('broken') ? 'link.unreachable' : null, httpStatus: call.body.url.includes('broken') ? 404 : 200, checkedAt: minutesAgo(0) }),
    'GET /links/taps': () => page([{ automationId: 12, channel: 'instagram', mediaId: '1790001', people: 40, taps: 55 }]),
    'GET /measurement-ids': () => page([{ id: 7, mediaId: '1790001', kind: 'amazon_tag', network: 'amazon', value: 'kesar-21', updatedAt: minutesAgo(60) }]),
    'POST /measurement-ids': (call) => [201, { id: 8, network: '', updatedAt: minutesAgo(0), ...call.body, warnings: [{ code: 'shared_id', message: 'Another reel uses this ID too.' }] }],
    'PATCH /measurement-ids/:id': (call) => ({ id: 7, mediaId: '1790001', kind: 'amazon_tag', network: 'amazon', value: call.body.value, updatedAt: minutesAgo(0), warnings: [] }),
    'DELETE /measurement-ids/:id': () => null,
    ...extra,
  };
}

const open = (path = '/links', { extra, ...options } = {}) => openAt(path, { list: [links], routes: routes(extra), ...options });

test('checking a link shows the exact address people open, with nothing in between', async () => {
  const { server } = await open();
  await fireEvent.changeText(await screen.findByTestId('links-url'), 'https://kesar.example.com/spice');
  await fireEvent.press(screen.getByTestId('links-run'));
  expect(await screen.findByTestId('links-final-url')).toBeTruthy();
  expect(screen.getByTestId('links-final-url').props.children).toBe('https://kesar.example.com/spice?utm_source=instagram&utm_medium=dm');
  expect(screen.getByTestId('links-allowed')).toBeTruthy();
  expect(await screen.findByTestId('links-opens')).toBeTruthy();
  expect(callsTo(server, 'POST', '/links/preview').map((c) => c.body)).toEqual([{ url: 'https://kesar.example.com/spice' }]);
});

test('a link the rules refuse says the engine’s reason; one that doesn’t open says so', async () => {
  await open();
  await fireEvent.changeText(await screen.findByTestId('links-url'), 'https://bit.ly/abc');
  await fireEvent.press(screen.getByTestId('links-run'));
  expect(await screen.findByTestId('links-not-allowed')).toBeTruthy();
  expect(screen.getByText(/Short links that hide the destination aren’t allowed\./)).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('links-url'), 'https://kesar.example.com/broken');
  await fireEvent.press(screen.getByTestId('links-run'));
  expect(await screen.findByTestId('links-broken')).toBeTruthy();
});

test('something that is not a full address is caught before it is sent', async () => {
  const { server } = await open();
  await fireEvent.changeText(await screen.findByTestId('links-url'), 'kesar shop');
  await fireEvent.press(screen.getByTestId('links-run'));
  expect(await screen.findByText('Paste the full address, starting with https://')).toBeTruthy();
  expect(callsTo(server, 'POST', '/links/preview')).toEqual([]);
});

test('taps by automation, and the tracking IDs per reel, with the warning the server gives', async () => {
  const { server } = await open();
  expect(await screen.findByTestId('tap-12-1790001')).toBeTruthy();
  expect(screen.getByText('40 people, 55 taps, Instagram')).toBeTruthy();
  expect(await screen.findByTestId('tracking-7')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('tracking-media'), '1790002');
  await fireEvent.changeText(screen.getByTestId('tracking-value'), 'kesar-22');
  await fireEvent.press(screen.getByTestId('tracking-add'));
  await waitFor(() => expect(callsTo(server, 'POST', '/measurement-ids').map((c) => c.body)).toEqual([{ mediaId: '1790002', kind: 'amazon_tag', value: 'kesar-22' }]));
  expect(await screen.findByText('Another reel uses this ID too.')).toBeTruthy();
});

test('offline, the saved taps stay and nothing can be checked or changed', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/links', { network });
  await screen.findByTestId('tap-12-1790001');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('tracking-add').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('tap-12-1790001')).toBeTruthy();
  expect(writes(server)).toEqual([]);
});

test('staff without the automations permission have no links screen', async () => {
  await open('/links', { user: staff(['orders']), list: [home, links] });
  expect(await screen.findByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('screen-links')).toBeNull();
});
