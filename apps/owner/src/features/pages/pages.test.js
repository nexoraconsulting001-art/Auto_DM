import { fireEvent, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { STAFF, fakeApi, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import pages from './index.js';
import themes from '../themes/index.js';
import brandKit from '../brand-kit/index.js';
import creator from '../creator/index.js';

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const at = '2026-11-10T10:00:00.000Z';
const PAGE = {
  id: 4, kind: 'reel', channel: 'instagram', mediaId: '1790', slug: 'diwali-box', headline: 'Diwali box', description: '', active: true, permalink: '', thumbnailUrl: '', mediaType: 'VIDEO', postedAt: at, expiresAt: null,
  coverUrl: '', leadForm: null, url: 'https://shop.example.com/r/diwali-box', categoryIds: [], productLimit: 20, createdAt: at, updatedAt: at,
  products: [{ id: 1, name: 'Spice box', pricePaise: 59900, image: '', active: true, soldOut: false, position: 0 }, { id: 2, name: 'Diya', pricePaise: 19900, image: '', active: true, soldOut: true, position: 1 }],
};
const CATALOGUE = { id: 1, name: 'Spice box' };

function api(extra = {}, user) {
  return fakeApi({
    ...(user ? { user } : {}),
    routes: {
      'GET /pages': () => ({ items: [{ ...PAGE, products: undefined, productCount: 2, visits: null }], nextCursor: null }),
      'GET /pages/:id': () => PAGE,
      'PATCH /pages/:id': (call) => ({ ...PAGE, ...call.body }),
      'GET /categories': () => ({ items: [], nextCursor: null }),
      'GET /theme/presets': () => ({ items: [{ code: 'utsav', name: 'Utsav', madeFor: 'Fashion and ethnic wear', colors: { ground: '#FBF6EE', hero: '#4A1026', accent: '#D4AF37' }, headingFont: 'Cormorant Garamond', bodyFont: 'Figtree', slots: { radius: 14 } }, { code: 'tadka', name: 'Tadka', madeFor: 'Food and pantry', colors: { ground: '#FFF8E6', hero: '#2B1406', accent: 'not-a-colour' }, headingFont: 'Bricolage Grotesque', bodyFont: 'Figtree', slots: { radius: 8 } }] }),
      'GET /theme': () => ({ preset: 'utsav', presetName: 'Utsav', colors: {}, headingFont: '', bodyFont: '', logoUrl: '', slots: { radius: 14 }, sealText: '', tickerItems: [], source: 'preset', check: false, notes: [], accentFrom: '', website: '' }),
      'PUT /theme': (call) => ({ preset: call.body.preset, presetName: 'Tadka', colors: {}, headingFont: '', bodyFont: '', logoUrl: '', slots: { radius: 8 }, sealText: '', tickerItems: [], source: 'preset', check: false, notes: [], accentFrom: 'logo', website: '' }),
      'GET /theme/site-reads': () => ({ items: [], nextCursor: null }),
      'GET /brand-kit': () => ({ preset: 'utsav', presetName: 'Utsav', logoUrl: '', logoDarkUrl: '', faviconUrl: '', colors: { primary: '#7A1F3D', accent: '' }, headingFont: 'Cormorant Garamond', bodyFont: 'Figtree', publicReplyVariants: ['Sent you the link!'] }),
      'GET /brand-kit/presets': () => ({ items: [], nextCursor: null }),
      'PATCH /brand-kit': (call) => ({ preset: 'utsav', presetName: 'Utsav', logoUrl: '', logoDarkUrl: '', faviconUrl: '', colors: { primary: '#7A1F3D', accent: '', ...call.body.colors }, headingFont: 'Cormorant Garamond', bodyFont: 'Figtree', publicReplyVariants: call.body.publicReplyVariants ?? ['Sent you the link!'] }),
      'GET /creator-page': () => ({ slug: 'asha', enabled: true, displayName: 'Asha', bio: '', photoUrl: '', websiteUrl: '', showWhatsapp: true, moreShelfTitle: 'More', url: 'https://shop.example.com/asha', badge: true, updatedAt: at }),
      'GET /creator-page/slug': (call) => ({ slug: 'shop', available: false, message: 'That name is taken by a page of the store', query: call.search }),
      'PATCH /creator-page': (call) => ({ slug: call.body.slug ?? 'asha', enabled: true, displayName: 'Asha', bio: call.body.bio ?? '', photoUrl: '', websiteUrl: '', showWhatsapp: true, moreShelfTitle: 'More', url: 'https://shop.example.com/asha', badge: true, updatedAt: at }),
      ...extra,
    },
  });
}

async function open(server, path, user) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs(user));
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [pages, themes, brandKit, creator], linking });
  return made;
}

test('a page’s DM link is its own direct address, and its products keep the owner’s order when moved', async () => {
  const server = api();
  await open(server, '/pages/4');
  expect((await screen.findByTestId('page-url')).props.children).toBe('https://shop.example.com/r/diwali-box');
  expect(screen.getByText('₹599')).toBeTruthy(); // the server's price in paise, formatted
  expect(screen.getByText('₹199 · Sold out')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('page-product-2-up'));
  await fireEvent.press(screen.getByTestId('page-save'));
  await settle();
  expect(server.calls.find((c) => c.method === 'PATCH').body.productIds).toEqual([2, 1]);
});

test('a page’s visits the server couldn’t count say Not available, never 0', async () => {
  await open(api(), '/pages');
  expect(await screen.findByTestId('page-4')).toBeTruthy();
  expect(screen.getByText(/Visits: Not available/)).toBeTruthy();
});

test('staff with the catalog permission see pages but not the managers’ settings and layout', async () => {
  const cataloguer = { ...STAFF, id: 12, permissions: ['catalog'] };
  await open(api({}, cataloguer), '/pages', cataloguer);
  expect(await screen.findByTestId('pages-add')).toBeTruthy();
  expect(screen.queryByTestId('pages-open-settings')).toBeNull();
  expect(screen.queryByTestId('pages-open-layout')).toBeNull();
});

test('the looks are listed with the one in use marked; picking another changes only the look', async () => {
  const server = api();
  await open(server, '/look');
  expect(await screen.findByTestId('look-utsav-current')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('look-tadka'));
  await settle();
  expect(server.calls.find((c) => c.method === 'PUT').body).toEqual({ preset: 'tadka', tuneAccent: true });
  expect(await screen.findByTestId('theme-chosen')).toBeTruthy();
});

test('the brand kit refuses a colour that is not #RRGGBB before sending, and sends only what changed', async () => {
  const server = api();
  await open(server, '/brand-kit');
  await fireEvent.changeText(await screen.findByTestId('brand-kit-color-accent'), 'gold');
  await fireEvent.press(screen.getByTestId('brand-kit-save'));
  expect(screen.getByText('Use a colour like #234D33')).toBeTruthy();
  expect(server.calls.some((c) => c.method === 'PATCH')).toBe(false);
  await fireEvent.changeText(screen.getByTestId('brand-kit-color-accent'), '#D4AF37');
  await fireEvent.press(screen.getByTestId('brand-kit-save'));
  await settle();
  expect(server.calls.find((c) => c.method === 'PATCH').body).toEqual({ colors: { accent: '#D4AF37' } });
});

test('the creator page shows its link for the bio, checks a name, and shows the server’s reason', async () => {
  const server = api();
  await open(server, '/creator-page');
  expect((await screen.findByTestId('creator-url')).props.children).toBe('https://shop.example.com/asha');
  await fireEvent.changeText(screen.getByTestId('creator-slug'), 'shop');
  await fireEvent.press(screen.getByTestId('creator-slug-check'));
  expect(await screen.findByText('That name is taken by a page of the store')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('creator-slug'), 'Not A Slug!');
  await fireEvent.press(screen.getByTestId('creator-save'));
  expect(screen.getByText('Use 2 to 40 lower-case letters, numbers and dashes')).toBeTruthy();
  expect(server.calls.some((c) => c.method === 'PATCH')).toBe(false);
});
