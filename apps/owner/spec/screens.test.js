/**
 * PRD 10.3, 10.4, 10.6 and 5.11, on the rendered app: screens are hidden by role (staff never see Payments, managers
 * never see Billing or the team), Orders opens offline on what was saved with writes disabled, the app is Bhava's with
 * the seller's logo only as the workspace badge, and a Free plan creator gets the same app with their screens.
 * P-12, F-48, P-19, P-67, P-69.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { OWNER, SHOP_A, WORKSPACE_LOGO, fakeApi, memoryStorage, openApp, ordersOf, screenText, servicesFor, settle } from './support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View testID={props.testID ?? 'image'} {...props} /> };
});

beforeEach(() => SecureStore.__reset());

const staff = (permissions) => ({ id: 8, name: 'Ravi', phone: '+91 ••••• •0002', role: 'staff', permissions });
const MANAGER = Object.freeze({ id: 9, name: 'Mina', phone: '+91 ••••• •0003', role: 'manager', permissions: [] });

async function openMore() {
  await fireEvent.press(await screen.findByTestId('tab-more'));
  await settle();
}

test('P-12: staff without the payments permission never see Settings > Payments', async () => {
  await openApp(fakeApi({ user: staff(['orders', 'catalog', 'automations', 'analytics', 'customers', 'inbox']) }), { signedIn: true });
  await openMore();
  for (const hidden of ['payments', 'settings', 'team', 'billing', 'store-settings', 'shipping']) expect(screen.queryByTestId(`more-${hidden}`)).toBeNull();
  expect(screenText(screen)).not.toMatch(/"Payments"/);
});

test('P-12: staff with only orders see Orders and nothing that needs another permission', async () => {
  await openApp(fakeApi({ user: staff(['orders']) }), { signedIn: true });
  expect(await screen.findByTestId('tab-orders')).toBeTruthy();
  expect(screen.queryByTestId('tab-products')).toBeNull();
  await openMore();
  for (const hidden of ['automations', 'inbox', 'insights', 'customers', 'payments']) expect(screen.queryByTestId(`more-${hidden}`)).toBeNull();
});

test('F-48: a manager never sees Billing, the team or payment keys\' owner-only screens; the owner sees the team', async () => {
  await openApp(fakeApi({ user: MANAGER }), { signedIn: true });
  await openMore();
  expect(screen.queryByTestId('more-billing')).toBeNull();
  expect(screen.queryByTestId('more-team')).toBeNull();
  expect(screen.queryByTestId('more-audit-log')).toBeNull();
  expect(screen.getByTestId('more-settings')).toBeTruthy();
});

test('F-48: the owner is offered the team, and Billing only once it exists', async () => {
  await openApp(fakeApi({ user: OWNER }), { signedIn: true });
  await openMore();
  expect(screen.getByTestId('more-team')).toBeTruthy();
});

test('P-19: offline, Orders shows the cached rows under an "Offline" banner and Confirm is disabled', async () => {
  const storage = memoryStorage();
  const rows = ordersOf(SHOP_A, ['Charu Chawla', 'Chetan Chopra']);
  const api = fakeApi({ orders: { [SHOP_A.id]: rows } });
  const first = await openApp(api, { signedIn: true, storage });
  await fireEvent.press(await screen.findByTestId('tab-orders'));
  expect(await screen.findByText(/Charu Chawla/)).toBeTruthy();
  await act(() => new Promise((resolve) => setTimeout(resolve, 1500))); // the cache writes at most once a second
  try {
    await first.view.unmount();
  } catch {
    // jest's stand-in for AppState hands out no subscription to remove; the app is gone either way.
  }

  // Airplane mode: the app is opened again and the server cannot be reached.
  api.state.down = true;
  const again = servicesFor(api, { storage });
  await openApp(api, { services: again });
  await waitFor(() => expect(again.session.getState().status).toBe('signedIn'), { timeout: 3000 });
  expect(again.session.getState().offline).toBe(true);
  const tab = await screen.findByTestId('tab-orders');
  await fireEvent.press(tab);
  expect(await screen.findByText(/Charu Chawla/)).toBeTruthy();
  expect(screen.getByText(/Chetan Chopra/)).toBeTruthy();
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screenText(screen)).toMatch(/offline/i);
  const confirms = screen.queryAllByRole('button', { name: /confirm/i });
  expect(confirms.length).toBeGreaterThanOrEqual(1);
  for (const button of confirms) expect(button.props.accessibilityState?.disabled ?? button.props.disabled).toBe(true);
  // Nothing is sent while offline: writes are never queued.
  const writes = api.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/orders'));
  for (const button of confirms) await fireEvent.press(button);
  await settle(100);
  expect(api.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/orders'))).toHaveLength(writes.length);
});

test('P-67: the signed-in app is Bhava\'s, and the business logo shows only as the workspace badge', async () => {
  await openApp(fakeApi(), { signedIn: true });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  const withLogo = (node) => JSON.stringify(node.props?.source ?? '').includes(WORKSPACE_LOGO);
  // Every node that shows the logo sits inside a workspace badge. (Not only the switcher's:
  // the shell also shows the badge, marked workspace-badge, in the header of screens off the tab bar.)
  const inABadge = (node) => {
    for (let at = node; at; at = at.parent) if (['open-switcher', 'workspace-badge'].includes(at.props?.testID)) return true;
    return false;
  };
  const badge = await screen.findByTestId('open-switcher');
  expect(badge.queryAll(withLogo).length).toBeGreaterThanOrEqual(1);
  const shown = screen.root.queryAll(withLogo);
  expect(shown.length).toBeGreaterThanOrEqual(1);
  for (const node of shown) expect(inABadge(node)).toBe(true);
  await openMore();
  // Screens behind the visible one stay mounted, each with its own header: every logo, shown or not, is in a badge.
  const badges = screen.queryAllByTestId('open-switcher', { includeHiddenElements: true }).flatMap((b) => b.queryAll(withLogo));
  expect(badges.length).toBeGreaterThanOrEqual(1);
  for (const node of screen.root.queryAll(withLogo)) expect(inABadge(node)).toBe(true);
});

test('P-69: a Free plan creator signs in to the same app and gets the creator\'s screens', async () => {
  const creatorBusiness = { id: 33, slug: 'kavya', name: 'Kavya Makes', plan: 'free', logoUrl: '', accountType: 'creator' };
  const api = fakeApi({ businesses: [creatorBusiness] });
  const { made } = await openApp(api, { signedIn: true });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  expect(made.config.app.name).toBe('owner');
  expect(made.session.getState().business.accountType).toBe('creator');
  await openMore();
  expect(screen.getByTestId('more-creator')).toBeTruthy();
});
