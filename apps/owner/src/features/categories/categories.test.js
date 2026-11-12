import { act, fireEvent, screen, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import categories from './index.js';

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const cat = (id, name, extra = {}) => ({ id, name, slug: name.toLowerCase(), imageUrl: '', description: '', position: id, visible: true, productCount: 2, reelCount: 3, ...extra });
const reel = (pageId, headline, extra = {}) => ({ pageId, slug: `r${pageId}`, kind: 'reel', headline, thumbnailUrl: '', position: pageId, pinned: false, pinPosition: null, startsAt: null, endsAt: null, joinedBy: 'owner', live: true, hiddenReason: '', ...extra });
const REELS = [reel(1, 'Spice box', { pinned: true, pinPosition: 0, position: 2 }), reel(2, 'Brass diya', { position: 0 }), reel(3, 'Toran', { position: 1, live: false, hiddenReason: 'before_window' })];

function api(extra = {}) {
  const server = fakeApi({
    routes: {
      'GET /categories': () => ({ items: [cat(1, 'Gifts'), cat(2, 'Kitchen'), cat(3, 'Decor', { visible: false })], nextCursor: null }),
      'GET /categories/:id': () => cat(9, 'Gifts'),
      'GET /categories/:id/reels': () => ({ categoryId: 9, items: server.reels }),
      'GET /categories/:id/rules': () => ({ items: [] }),
      'GET /pages': () => ({ items: [], nextCursor: null }),
      ...extra,
    },
  });
  server.reels = REELS.map((r) => ({ ...r }));
  return server;
}

async function open(server, path, { network } = {}) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs());
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [categories], linking, ...(network ? { network } : {}) });
  return made;
}
const order = () => screen.getAllByTestId(/^category-\d+-open$/).map((row) => row.props.testID);
const reelOrder = () => screen.getAllByTestId(/^reel-\d+-position$/).map((n) => n.props.testID.split('-')[1]);

test('moving a category saves the whole order at once', async () => {
  const server = api({ 'PUT /categories/order': () => null });
  await open(server, '/categories');
  await screen.findByTestId('category-2');
  await fireEvent.press(screen.getByTestId('category-2-up'));
  await settle();
  expect(order()).toEqual(['category-2-open', 'category-1-open', 'category-3-open']);
  expect(server.calls.find((c) => c.method === 'PUT').body).toEqual({ ids: [2, 1, 3] });
});

test('a category move the server refuses puts the list back and says so', async () => {
  const server = api({ 'PUT /categories/order': () => [500, { error: 'x', code: 'internal' }] });
  await open(server, '/categories');
  await screen.findByTestId('category-3');
  await fireEvent.press(screen.getByTestId('category-3-up'));
  await settle();
  expect(order()).toEqual(['category-1-open', 'category-2-open', 'category-3-open']);
  expect(screen.getByTestId('categories-reorder-failed')).toBeTruthy();
});

test('the reel order shows pinned first, then the rest, and a hidden reel keeps its place with why', async () => {
  await open(api(), '/categories/9/reels');
  await screen.findByTestId('reel-1');
  expect(reelOrder()).toEqual(['1', '2', '3']);
  expect(screen.getByTestId('reel-1-pinned')).toBeTruthy();
  expect(within(screen.getByTestId('reel-3-hidden')).getByText('Not started yet')).toBeTruthy();
  expect(screen.getByTestId('reel-1-up').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('reel-1-down').props.accessibilityState.disabled).toBe(true); // the only pinned one: it can't cross the line
});

test('moving a reel sends the pinned and the rest in their new order', async () => {
  const server = api({
    'PUT /categories/:id/reels': (call) => {
      server.reels = [reel(1, 'Spice box', { pinned: true, pinPosition: 0, position: 2 }), reel(3, 'Toran', { position: 0 }), reel(2, 'Brass diya', { position: 1 })];
      return { categoryId: 9, items: server.reels, body: call.body };
    },
  });
  await open(server, '/categories/9/reels');
  await screen.findByTestId('reel-3');
  await fireEvent.press(screen.getByTestId('reel-3-up'));
  await settle();
  expect(server.calls.find((c) => c.method === 'PUT').body).toEqual({ pinned: [1], order: [3, 2] });
  expect(reelOrder()).toEqual(['1', '3', '2']);
});

test('a reel move that fails puts the list back as it was and says why', async () => {
  const server = api({ 'PUT /categories/:id/reels': () => [409, { error: 'Someone else changed this order. Reload to see it.', code: 'conflict' }] });
  await open(server, '/categories/9/reels');
  await screen.findByTestId('reel-3');
  await fireEvent.press(screen.getByTestId('reel-3-up'));
  await settle();
  expect(reelOrder()).toEqual(['1', '2', '3']);
  expect(screen.getByTestId('reel-order-failed')).toBeTruthy();
  expect(screen.getByText('Someone else changed this order. Reload to see it.')).toBeTruthy();
});

test('pinning goes through the pin route and keeps the server’s answer; offline, nothing moves', async () => {
  const network = fakeNetwork(true);
  const server = api({
    'POST /categories/:id/reels/pin': (call) => {
      server.reels = [reel(1, 'Spice box', { pinned: true, pinPosition: 0, position: 2 }), reel(2, 'Brass diya', { pinned: true, pinPosition: 1, position: 0 }), reel(3, 'Toran', { position: 1 })];
      return { categoryId: 9, items: server.reels, sent: call.body };
    },
  });
  await open(server, '/categories/9/reels', { network });
  await fireEvent.press(await screen.findByTestId('reel-2-pin'));
  await settle();
  expect(server.calls.find((c) => c.path.endsWith('/pin')).body).toEqual({ pageId: 2 });
  expect(screen.getByTestId('reel-2-pinned')).toBeTruthy();
  await act(async () => network.set(false));
  await settle();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('reel-3-up').props.accessibilityState.disabled).toBe(true);
});

test('an empty category says how reels get in', async () => {
  const server = api();
  server.reels = [];
  await open(server, '/categories/9/reels');
  expect(await screen.findByTestId('reel-order-empty')).toBeTruthy();
});
