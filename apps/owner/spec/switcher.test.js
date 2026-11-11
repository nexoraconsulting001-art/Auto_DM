/**
 * PRD 10.3 and 10.5, on the rendered app: the switcher lists exactly the person's businesses, switching shows only the
 * new business's orders with no stale rows, and tapping a push for another business switches to it before the record
 * opens. P-09, P-10, P-13.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { SHOP_A, SHOP_B, fakeApi, fakeNotifications, openApp, ordersOf, pushResponse, screenText, settle } from './support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

beforeEach(() => SecureStore.__reset());

const STAFF = Object.freeze({ id: 8, name: 'Ravi', phone: '+91 ••••• •0002', role: 'staff', permissions: ['orders'] });

test('P-09: a staff member in two businesses sees exactly those two in the switcher', async () => {
  const api = fakeApi({ user: STAFF, businesses: [SHOP_A, SHOP_B] });
  await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('open-switcher'));
  expect(await screen.findByTestId(`switcher-business-${SHOP_A.id}`)).toBeTruthy();
  expect(screen.getByTestId(`switcher-business-${SHOP_B.id}`)).toBeTruthy();
  expect(screen.queryAllByTestId(/^switcher-business-/)).toHaveLength(2);
  expect(screenText(screen)).toMatch(/Alpha Works/);
  expect(screenText(screen)).toMatch(/Beta Studio/);
});

test('P-09: a person in one business sees one, and the list is the server\'s, not what the app remembered', async () => {
  const api = fakeApi({ businesses: [SHOP_A] });
  const { made } = await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('open-switcher'));
  await settle();
  expect(screen.queryAllByTestId(/^switcher-business-/)).toHaveLength(1);
  expect(made.session.getState().businesses.map((b) => b.id)).toEqual([SHOP_A.id]);
});

test('P-10: switching while on Orders shows only the new business\'s orders, with no stale rows', async () => {
  const api = fakeApi({ orders: { [SHOP_A.id]: ordersOf(SHOP_A, ['Anika Arora', 'Arjun Apte']), [SHOP_B.id]: ordersOf(SHOP_B, ['Bela Bose']) } });
  const { made } = await openApp(api, { signedIn: true });
  await fireEvent.press(await screen.findByTestId('tab-orders'));
  expect(await screen.findByText(/Anika Arora/)).toBeTruthy();
  expect(screen.getByText(/Arjun Apte/)).toBeTruthy();

  await fireEvent.press(screen.getByTestId('open-switcher'));
  await fireEvent.press(await screen.findByTestId(`switcher-business-${SHOP_B.id}`));
  await waitFor(() => expect(made.session.getState().tenantId).toBe(SHOP_B.id));
  // Whatever screen the app shows now, nothing of the old business is on it, and Orders holds the new one's rows.
  await settle(100);
  expect(screenText(screen)).not.toMatch(/Anika Arora|Arjun Apte/);
  const tab = screen.queryByTestId('tab-orders');
  if (tab) await fireEvent.press(tab);
  expect(await screen.findByText(/Bela Bose/)).toBeTruthy();
  expect(screenText(screen)).not.toMatch(/Anika Arora|Arjun Apte/);
  const listCalls = api.calls.filter((c) => c.path.startsWith('/orders') && c.tenant === String(SHOP_B.id));
  expect(listCalls.length).toBeGreaterThanOrEqual(1);
  // Nothing of the old business is kept in memory either.
  const cached = JSON.stringify(made.queryClient.getQueryCache().getAll().map((q) => q.state.data ?? null));
  expect(cached).not.toMatch(/Anika Arora|Arjun Apte/);
});

test('P-13: tapping a push for another business switches to it first, then opens the order', async () => {
  const order = ordersOf(SHOP_B, ['Bela Bose'])[0];
  const api = fakeApi({ orders: { [SHOP_A.id]: [], [SHOP_B.id]: [order] } });
  const notifications = fakeNotifications();
  const { made } = await openApp(api, { signedIn: true, notifications });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  expect(made.session.getState().tenantId).toBe(SHOP_A.id);
  const mark = api.calls.length;
  await act(async () => {
    notifications.tap(pushResponse({ tenantId: String(SHOP_B.id), link: `/orders/${order.id}`, kind: 'order.cod_to_confirm' }));
  });
  await waitFor(() => expect(made.session.getState().tenantId).toBe(SHOP_B.id));
  const after = api.calls.slice(mark);
  const switched = after.findIndex((c) => c.path === '/auth/me' && c.tenant === String(SHOP_B.id));
  expect(switched).toBeGreaterThanOrEqual(0);
  // The order is opened in the new business, after the switch.
  await waitFor(() => expect(after.concat(api.calls.slice(mark + after.length)).some((c) => c.path === `/orders/${order.id}` && c.tenant === String(SHOP_B.id))).toBe(true), { timeout: 3000 });
  const opened = api.calls.slice(mark).findIndex((c) => c.path === `/orders/${order.id}`);
  expect(opened).toBeGreaterThan(switched);
  expect(await screen.findByText(new RegExp(order.orderNumber))).toBeTruthy();
});

test('P-13: a push for a business the person is not in opens nothing and switches nothing', async () => {
  const api = fakeApi();
  const notifications = fakeNotifications();
  const { made } = await openApp(api, { signedIn: true, notifications });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  const mark = api.calls.length;
  await act(async () => {
    notifications.tap(pushResponse({ tenantId: '999', link: '/orders/5' }));
    notifications.tap(pushResponse({ tenantId: String(SHOP_B.id), link: 'https://elsewhere.example/orders/5' }));
    notifications.tap(pushResponse({ link: '/orders/5' }));
  });
  await settle(100);
  expect(made.session.getState().tenantId).toBe(SHOP_A.id);
  expect(api.calls.slice(mark).some((c) => c.path === '/orders/5')).toBe(false);
});

test('P-13: a push that launched the app is opened once the session is ready', async () => {
  const order = ordersOf(SHOP_B, ['Bela Bose'])[0];
  const api = fakeApi({ orders: { [SHOP_B.id]: [order] } });
  const notifications = fakeNotifications({ tapped: pushResponse({ tenantId: String(SHOP_B.id), link: `/orders/${order.id}` }) });
  const { made } = await openApp(api, { signedIn: true, notifications });
  await waitFor(() => expect(made.session.getState().tenantId).toBe(SHOP_B.id), { timeout: 3000 });
});
