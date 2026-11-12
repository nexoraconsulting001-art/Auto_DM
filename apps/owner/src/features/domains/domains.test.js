import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { OWNER, fakeNetwork } from '../../shell/testing.js';
import { buildNavigation, linkTarget } from '../../shell/menu.js';
import { MANAGER, callsTo, minutesAgo, openAt, page, reset, staff, writes } from '../compliance/testing.js';
import home from '../home/index.js';
import domains from './index.js';
import { cleanDomain, looksLikeDomain } from './DomainsScreen.js';

jest.setTimeout(30000);
beforeEach(reset);

const PENDING = { id: 'shop.kesar.in', domain: 'shop.kesar.in', status: 'pending', isPrimary: false, records: [{ type: 'CNAME', name: 'shop', value: 'stores.example.net' }, { type: 'TXT', name: '_verify.shop', value: 'v=abc123' }], verifiedAt: null, lastCheckedAt: minutesAgo(5) };
const LIVE = { id: 'kesar.in', domain: 'kesar.in', status: 'verified', isPrimary: true, records: [], verifiedAt: minutesAgo(9000), lastCheckedAt: minutesAgo(60) };

function routes(extra = {}) {
  return {
    'GET /domains': () => page([LIVE, PENDING]),
    'POST /domains': (call) => [201, { ...PENDING, id: call.body.domain, domain: call.body.domain }],
    'POST /domains/:id/check': () => ({ ...PENDING, status: 'verified', verifiedAt: minutesAgo(0) }),
    'PUT /domains/primary': (call) => ({ ...LIVE, domain: call.body.domain }),
    'DELETE /domains/:id': () => null,
    ...extra,
  };
}

const open = (options = {}) => {
  const { extra, ...rest } = options;
  return openAt('/domains', { list: [domains], routes: routes(extra), ...rest });
};

test('the owner sees each address, the records to add for one not yet working, and checks it', async () => {
  const { server } = await open();
  expect(await screen.findByTestId('domain-kesar.in-primary')).toBeTruthy();
  expect(screen.getByText('stores.example.net')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('domain-shop.kesar.in-check'));
  await waitFor(() => expect(callsTo(server, 'POST', '/domains/shop.kesar.in/check')).toHaveLength(1));
  expect(await screen.findByTestId('domains-verified')).toBeTruthy();
});

test('adding a domain cleans what was typed and refuses what isn’t one', async () => {
  const { server } = await open();
  await fireEvent.changeText(await screen.findByTestId('domains-new'), 'not a domain');
  await fireEvent.press(screen.getByTestId('domains-add'));
  expect(callsTo(server, 'POST', '/domains')).toEqual([]);
  await fireEvent.changeText(screen.getByTestId('domains-new'), 'https://Store.Kesar.in/');
  await fireEvent.press(screen.getByTestId('domains-add'));
  await waitFor(() => expect(callsTo(server, 'POST', '/domains').map((c) => c.body)).toEqual([{ domain: 'store.kesar.in' }]));
});

test('a plan without custom domains: the server’s refusal is said plainly', async () => {
  await open({ extra: { 'POST /domains': () => [403, { error: 'Custom domains aren’t included in your plan.', code: 'forbidden' }] } });
  await fireEvent.changeText(await screen.findByTestId('domains-new'), 'store.kesar.in');
  await fireEvent.press(screen.getByTestId('domains-add'));
  expect(await screen.findByTestId('domains-refusal')).toBeTruthy();
});

test('a plan without custom domains has no domains screen, and no link opens it', () => {
  const nav = buildNavigation([home, domains], { user: OWNER, entitlements: { custom_domain: false } });
  expect(nav.screens.some((screen) => screen.feature === 'domains')).toBe(false);
  expect(linkTarget('/domains', nav)).toBeNull();
  expect(buildNavigation([home, domains], { user: OWNER, entitlements: { custom_domain: true } }).screens.some((screen) => screen.feature === 'domains')).toBe(true);
});

test('managers and staff with the catalog see the list; every change is the owner’s', async () => {
  const { server } = await open({ user: MANAGER });
  expect(await screen.findByTestId('domain-kesar.in')).toBeTruthy();
  expect(screen.getByTestId('domains-owner-only')).toBeTruthy();
  expect(screen.queryByTestId('domains-add')).toBeNull();
  expect(screen.queryByTestId('domain-shop.kesar.in-check')).toBeNull();
  expect(writes(server)).toEqual([]);
});

test('staff without the catalog permission have no domains screen', async () => {
  await open({ user: staff(['orders']), list: [home, domains] });
  expect(await screen.findByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('screen-domains')).toBeNull();
});

test('removing asks first; offline every change is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open({ network });
  await fireEvent.press(await screen.findByTestId('domain-shop.kesar.in-remove'));
  await fireEvent.press(screen.getByTestId('domains-remove-confirm-cancel'));
  expect(writes(server)).toEqual([]);
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('domain-shop.kesar.in-remove').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('domain-kesar.in')).toBeTruthy();
});

test('what was typed becomes a bare domain', () => {
  expect(cleanDomain(' HTTPS://Shop.Example.com/path?x=1 ')).toBe('shop.example.com');
  expect(cleanDomain('shop.example.com.')).toBe('shop.example.com');
  expect(looksLikeDomain('shop.example.com')).toBe(true);
  expect(looksLikeDomain('localhost')).toBe(false);
  expect(looksLikeDomain('-bad-.example.com')).toBe(false);
});
