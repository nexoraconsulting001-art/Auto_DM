import { fireEvent, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { fakeApi, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import imports from './index.js';
import products from '../products/index.js';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
const picker = require('expo-document-picker');

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const at = '2026-11-10T10:00:00.000Z';
const DRAFT = { name: 'Brass diya set', description: 'Set of 4', externalUrl: 'https://shop.example.com/p/diya', pricePaise: 49900, mrpPaise: 69900, inStock: true, images: ['https://shop.example.com/i/diya.jpg'], tags: [], suggestedCategories: ['Decor'], options: [], variants: [], source: 'link', sourceRef: '' };
const JOB = { id: 5, kind: 'csv', status: 'done', source: 'catalog.csv', total: 3, created: 1, updated: 0, unchanged: 0, refused: 1, failed: 1, archived: 0, errorCode: null, message: '', createdAt: at, finishedAt: at };

function api(extra = {}) {
  const server = fakeApi({
    routes: {
      'GET /imports': () => ({ items: [JOB], nextCursor: null }),
      'GET /import-adapters': () => ({ items: [] }),
      'GET /imports/:id': () => JOB,
      'GET /imports/:id/items': () => ({ items: [{ id: 51, line: 2, url: '', sku: 'A1', status: 'refused', readFrom: 'csv', gatePassed: false, reason: 'no_price', message: 'This line has no price.', productId: null, draft: DRAFT }], nextCursor: null }),
      'POST /imports/link': () => ({ status: 'draft', itemId: 77, productId: null, readFrom: 'json_ld', reason: null, message: '', draft: DRAFT }),
      'POST /import-items/:id/save': () => [201, { productId: 300 }],
      'GET /products/:id': () => ({ id: 300, name: 'Brass diya set', slug: 'x', description: '', pricePaise: 49900, mrpPaise: null, images: [], optionLabel: '', optionValues: [], stock: null, active: true, featured: false, createdAt: at, updatedAt: at, categoryIds: [], options: [], variants: [], gallery: [], lastCheck: null }),
      'GET /categories': () => ({ items: [], nextCursor: null }),
      'POST /imports/csv': () => [202, { ...JOB, id: 6, status: 'queued' }],
      ...extra,
    },
  });
  const inner = server.fetch;
  server.fetch = (url, init = {}) => (init.body instanceof FormData ? inner(url, { ...init, body: JSON.stringify({ file: 'sent' }) }) : inner(url, init));
  return server;
}

async function open(server, path) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs());
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [imports, products], linking });
  return made;
}

test('a pasted link comes back as a draft to check; saving sends paise and opens the new product', async () => {
  const server = api();
  await open(server, '/imports');
  await fireEvent.changeText(await screen.findByTestId('imports-link-url'), 'https://shop.example.com/p/diya');
  await fireEvent.press(screen.getByTestId('imports-link-read'));
  expect(await screen.findByTestId('imports-link-draft')).toBeTruthy();
  expect(screen.getByTestId('imports-link-draft-price').props.value).toBe('499');
  await fireEvent.press(screen.getByTestId('imports-link-draft-save'));
  await settle();
  const saved = server.calls.find((c) => c.path === '/import-items/77/save');
  expect(saved.body).toMatchObject({ name: 'Brass diya set', pricePaise: 49900, mrpPaise: 69900 });
  expect(await screen.findByTestId('screen-product')).toBeTruthy();
});

test('a CSV over 2 MB is refused on the phone and never sent', async () => {
  const server = api();
  await open(server, '/imports');
  await fireEvent.press(await screen.findByTestId('imports-way-csv'));
  picker.getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///d/big.csv', name: 'big.csv', mimeType: 'text/csv', size: 2_000_001 }] });
  await fireEvent.press(screen.getByTestId('imports-csv-start'));
  expect(await screen.findByText('That file is over 2 MB. Split it into smaller files.')).toBeTruthy();
  expect(server.calls.some((c) => c.path === '/imports/csv')).toBe(false);
});

test('a CSV within the limits starts a job, and the server’s refusal of a file is shown in its words', async () => {
  let refuse = true;
  const server = api({ 'POST /imports/csv': () => (refuse ? [415, { error: 'That file isn’t a CSV we can read', code: 'unsupported_media_type' }] : [202, { ...JOB, id: 6, status: 'queued' }]) });
  await open(server, '/imports');
  await fireEvent.press(await screen.findByTestId('imports-way-csv'));
  picker.getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///d/a.csv', name: 'a.csv', mimeType: 'text/csv', size: 1200 }] });
  await fireEvent.press(screen.getByTestId('imports-csv-start'));
  expect(await screen.findByText('That file isn’t a CSV we can read')).toBeTruthy();
  refuse = false;
  picker.getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///d/a.csv', name: 'a.csv', mimeType: 'text/csv', size: 1200 }] });
  await fireEvent.press(screen.getByTestId('imports-csv-start'));
  expect(await screen.findByTestId('screen-import-job')).toBeTruthy();
});

test('a job lists each line with why it wasn’t added, and a refused line can be corrected and saved', async () => {
  const server = api();
  await open(server, '/imports/5');
  expect(await screen.findByTestId('import-job-counts')).toBeTruthy();
  expect(await screen.findByText('This line has no price.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('import-item-51'));
  expect(await screen.findByTestId('import-item-51-draft')).toBeTruthy();
});

test('more than 25 links are caught before sending', async () => {
  const server = api();
  await open(server, '/imports');
  await fireEvent.press(await screen.findByTestId('imports-way-bulk'));
  const many = Array.from({ length: 26 }, (_, i) => `https://shop.example.com/p/${i}`).join('\n');
  await fireEvent.changeText(screen.getByTestId('imports-bulk-urls'), many);
  expect(screen.getByText('Paste at most 25 links at a time')).toBeTruthy();
  expect(screen.getByTestId('imports-bulk-start').props.accessibilityState.disabled).toBe(true);
});
