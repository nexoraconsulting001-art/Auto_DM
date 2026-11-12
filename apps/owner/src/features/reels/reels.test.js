import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { fakeNetwork } from '../../shell/testing.js';
import { callsTo, minutesAgo, openAt, page, reset, staff, writes } from '../compliance/testing.js';
import home from '../home/index.js';
import reels from './index.js';
import { addKeywords, formToReel, mergeReelCards, moveItem, NEW_REEL } from './form.js';

jest.setTimeout(30000);
beforeEach(reset);

const PRODUCTS = [
  { id: 1, name: 'Brass dabba', pricePaise: 49900, images: [], active: true, position: 0 },
  { id: 2, name: 'Masala set', pricePaise: 129950, images: [], active: false, position: 1 },
];
const REEL = {
  id: '1790001', slug: 'spice-box', headline: 'Spice Box Diwali', keywords: ['SPICE'], dmMessage: 'Hey @{username}! Here you go', buttonText: 'Shop now', publicReply: '', active: true,
  permalink: 'https://www.instagram.com/reel/a', thumbnailUrl: '', videoUrl: '', caption: 'Diwali box', storeUrl: 'https://kesar.example.com/r/spice-box', createdAt: minutesAgo(900), updatedAt: minutesAgo(60),
};
const SUMMARY = { ...REEL, productCount: 1, dmCount: 120, visitCount: 80, orderCount: 9 };
const POSTS = [
  { id: '1790001', caption: 'Diwali box', mediaType: 'VIDEO', permalink: REEL.permalink, thumbnailUrl: '', configured: true },
  { id: '1790002', caption: 'Brass diya set for the festival', mediaType: 'IMAGE', permalink: 'https://www.instagram.com/p/b', thumbnailUrl: '', configured: false },
];

function routes(extra = {}) {
  return {
    'GET /reels': () => page([SUMMARY]),
    'GET /instagram/posts': () => page(POSTS),
    'GET /reels/:id': () => ({ ...REEL, products: [PRODUCTS[0]] }),
    'PUT /reels/:id': (call) => ({ ...REEL, id: call.path.split('/').pop(), ...call.body, products: PRODUCTS.filter((p) => call.body.productIds.includes(p.id)) }),
    'DELETE /reels/:id': () => null,
    'GET /products': (call) => page(PRODUCTS.filter((p) => !call.search.includes('search=') || p.name.toLowerCase().includes(decodeURIComponent(call.search.split('search=')[1].split('&')[0]).toLowerCase()))),
    ...extra,
  };
}

const open = (path = '/reels', { extra, ...options } = {}) => openAt(path, { list: [reels], routes: routes(extra), ...options });

test('one card per Instagram post, with its store if it has one', async () => {
  await open();
  expect(await screen.findByTestId('reel-1790001')).toBeTruthy();
  expect(screen.getByText('Spice Box Diwali')).toBeTruthy();
  expect(screen.getByText('1 products, 120 DMs, 9 orders')).toBeTruthy();
  expect(within(screen.getByTestId('reel-1790002')).getByText('Not set up')).toBeTruthy();
});

test('Instagram being down never hides the stores already set up', async () => {
  await open('/reels', { extra: { 'GET /instagram/posts': () => [502, { error: 'Instagram didn’t answer', code: 'unavailable' }] } });
  expect(await screen.findByTestId('reel-1790001')).toBeTruthy();
  expect(await screen.findByTestId('reels-posts-failed')).toBeTruthy();
});

test('no posts and no stores says how to start', async () => {
  await open('/reels', { extra: { 'GET /reels': () => page([]), 'GET /instagram/posts': () => page([]) } });
  expect(await screen.findByTestId('reels-empty')).toBeTruthy();
});

test('setting up a post’s store: products from the catalog, a keyword, and one save with the post’s details', async () => {
  const { server } = await open('/reels/1790002');
  expect(await screen.findByTestId('reel-headline')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('reel-save'));
  expect(await screen.findByText('Pick at least 1 product for this reel')).toBeTruthy();
  expect(callsTo(server, 'PUT', '/reels/1790002')).toEqual([]);
  await fireEvent.press(screen.getByTestId('reel-add-products'));
  await fireEvent.press(await screen.findByTestId('reel-catalog-1-add'));
  await fireEvent.press(screen.getByTestId('reel-catalog-2-add'));
  expect(screen.getByText('₹1,299.50, archived')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('reel-product-2-up'));
  await fireEvent.changeText(screen.getByTestId('reel-keywords-draft'), 'diya,');
  await fireEvent.press(screen.getByTestId('reel-save'));
  await waitFor(() => expect(callsTo(server, 'PUT', '/reels/1790002')).toHaveLength(1));
  expect(callsTo(server, 'PUT', '/reels/1790002')[0].body).toMatchObject({ headline: 'Brass diya set for the festival', keywords: ['LINK', 'diya'], productIds: [2, 1], permalink: 'https://www.instagram.com/p/b', active: true, publicReply: '' });
  expect(await screen.findByTestId('reel-saved')).toBeTruthy();
});

test('the DM preview is the seller’s, with a stand-in name and no platform name', async () => {
  await open('/reels/1790001');
  expect(await screen.findByTestId('reel-preview')).toBeTruthy();
  expect(screen.getByTestId('reel-preview-text').props.children).toBe('Hey @asha! Here you go');
  expect(screen.getByTestId('reel-preview-name').props.children).toBe('Alpha Traders');
  expect(within(screen.getByTestId('reel-preview')).queryByText(/Bhava/i)).toBeNull();
  expect(NEW_REEL.dmMessage).not.toMatch(/Bhava/i);
});

test('a refusal from the server is shown in its words beside the field it names', async () => {
  await open('/reels/1790001', { extra: { 'PUT /reels/:id': () => [422, { error: 'Your plan allows 1 product per reel', code: 'validation_failed', fields: { productIds: 'Your plan allows 1 product per reel.' } }] } });
  await fireEvent.press(await screen.findByTestId('reel-save'));
  expect(await screen.findByTestId('reel-products-error')).toBeTruthy();
  expect(screen.getByText('Your plan allows 1 product per reel.')).toBeTruthy();
  expect(screen.getByTestId('reel-refusal')).toBeTruthy();
});

test('removing a store asks first', async () => {
  const { server } = await open('/reels/1790001');
  await fireEvent.press(await screen.findByTestId('reel-remove'));
  expect(writes(server)).toEqual([]);
  await fireEvent.press(screen.getByTestId('reel-remove-confirm-confirm'));
  await waitFor(() => expect(callsTo(server, 'DELETE', '/reels/1790001')).toHaveLength(1));
});

test('a post that is neither a store nor on Instagram is “not here”', async () => {
  await open('/reels/1790999');
  expect(await screen.findByTestId('reel-missing')).toBeTruthy();
});

test('offline, the saved store shows and saving is off', async () => {
  const network = fakeNetwork(true);
  const { server } = await open('/reels/1790001', { network });
  await screen.findByTestId('reel-save');
  network.set(false);
  expect(await screen.findByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('reel-save').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('reel-headline').props.editable).toBe(false);
  expect(writes(server)).toEqual([]);
});

test('staff without the automations permission have no reels tab', async () => {
  await open('/reels', { user: staff(['orders']), list: [home, reels] });
  expect(await screen.findByTestId('screen-home')).toBeTruthy();
  expect(screen.queryByTestId('tab-reels')).toBeNull();
});

test('the reel form’s rules', () => {
  expect(addKeywords(['LINK'], 'link, Shop ,shop')).toEqual(['LINK', 'Shop']);
  expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
  const form = { ...NEW_REEL, headline: ' X ', buttonText: 'A very long button text here', products: [] };
  expect(Object.keys(formToReel(form).errors).sort()).toEqual(['buttonText', 'products']);
  const cards = mergeReelCards(POSTS, [SUMMARY, { ...SUMMARY, id: '1780000', headline: 'Old reel' }]);
  expect(cards.map((c) => [c.id, Boolean(c.reel)])).toEqual([['1790001', true], ['1790002', false], ['1780000', true]]);
});
