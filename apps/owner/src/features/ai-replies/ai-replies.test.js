import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import aiReplies from './index.js';
import { AT, forgetApps, openAt, press, screenText, writes } from '../billing/testing.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.setTimeout(40_000);
afterEach(forgetApps);
beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const entry = (id, over = {}) => ({ id, question: `Do you ship to Pune ${id}?`, answer: 'Yes, in 3 days.', active: true, updatedAt: AT, ...over });
const settings = (over = {}) => ({ enabled: false, threshold: 0.8, configured: true, faqCount: 1, canEnable: true, ...over });

function aiRoutes(state = {}) {
  state.faq ??= [entry(1)];
  state.settings ??= settings();
  return {
    'GET /ai-replies': () => state.settings,
    'PATCH /ai-replies': (call) => { state.settings = { ...state.settings, ...call.body }; return state.settings; },
    'GET /faq': () => ({ items: state.faq, nextCursor: null }),
    'POST /faq': (call) => { const created = entry(state.faq.length + 10, call.body); state.faq = [...state.faq, created]; return [201, created]; },
    'PATCH /faq/:id': (call) => { const id = Number(call.path.split('/')[2]); state.faq = state.faq.map((e) => (e.id === id ? { ...e, ...call.body } : e)); return state.faq.find((e) => e.id === id); },
    'DELETE /faq/:id': (call) => { const id = Number(call.path.split('/')[2]); state.faq = state.faq.filter((e) => e.id !== id); return null; },
    'POST /ai-replies/test': () => ({ answer: 'Yes, we ship to Pune in 3 days.', sources: [{ kind: 'faq', id: 1, label: 'Do you ship to Pune 1?' }], score: 0.91, threshold: 0.8, wouldSend: true, reason: '' }),
    'GET /ai-replies/log': () => ({ items: [
      { id: 1, channel: 'instagram', threadId: 4, question: 'Where is my order?', answer: '', sourceIds: [], score: 0.4, model: 'm', outcome: 'handed_off', reason: 'ai.low_confidence', at: AT },
      { id: 2, channel: 'instagram', threadId: 5, question: '', answer: '', sourceIds: [], score: null, model: 'm', outcome: 'answered', reason: '', at: AT },
    ], nextCursor: null }),
    ...state.extra,
  };
}

test('the switch, the confidence and the FAQ show as the server has them', async () => {
  await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes() });
  await screen.findByTestId('ai-enabled');
  expect(await screen.findByText('Do you ship to Pune 1?')).toBeTruthy();
  expect(screenText()).toMatch(/80%/);
});

test('switching it on saves only the switch; the confidence saves only the confidence', async () => {
  const { server } = await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes() });
  await fireEvent.press(await screen.findByTestId('ai-enabled'));
  await waitFor(() => expect(writes(server).some((c) => c.method === 'PATCH' && c.path === '/ai-replies' && JSON.stringify(c.body) === '{"enabled":true}')).toBe(true));
  await press(/^90%$/);
  await waitFor(() => expect(writes(server).some((c) => c.path === '/ai-replies' && JSON.stringify(c.body) === '{"threshold":0.9}')).toBe(true));
});

test('it cannot be switched on with no active FAQ answer, and says why', async () => {
  const { server } = await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes({ settings: settings({ canEnable: false, faqCount: 0 }), faq: [] }) });
  await screen.findByTestId('ai-enabled');
  expect(screenText()).toMatch(/Add at least one active FAQ answer first/);
  await fireEvent.press(screen.getByTestId('ai-enabled'));
  expect(writes(server)).toHaveLength(0);
  expect(await screen.findByText('No FAQ answers yet')).toBeTruthy();
});

test('a question and answer are added, edited and removed', async () => {
  const state = {};
  const { server } = await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes(state) });
  await fireEvent.press(await screen.findByTestId('faq-add'));
  await fireEvent.press(await screen.findByTestId('faq-save'));
  expect(screenText()).toMatch(/Write the question/);
  expect(writes(server).some((c) => c.path === '/faq')).toBe(false);
  await fireEvent.changeText(screen.getByTestId('faq-question'), '  Do you take returns?  ');
  await fireEvent.changeText(screen.getByTestId('faq-answer'), 'Yes, within 7 days.');
  await fireEvent.press(screen.getByTestId('faq-save'));
  await waitFor(() => expect(writes(server).find((c) => c.method === 'POST' && c.path === '/faq')?.body).toEqual({ question: 'Do you take returns?', answer: 'Yes, within 7 days.', active: true }));
  await screen.findByText('Do you take returns?');
  await fireEvent.press(await screen.findByTestId('faq-1-edit'));
  await fireEvent.changeText(await screen.findByTestId('faq-answer'), 'Yes, in 2 days.');
  await fireEvent.press(screen.getByTestId('faq-save'));
  await waitFor(() => expect(writes(server).some((c) => c.method === 'PATCH' && c.path === '/faq/1' && c.body.answer === 'Yes, in 2 days.')).toBe(true));
  await fireEvent.press(await screen.findByTestId('faq-1-remove'));
  await waitFor(() => expect(writes(server).some((c) => c.method === 'DELETE' && c.path === '/faq/1')).toBe(true));
});

test('a plan without the add-on meets the upgrade prompt from the server’s refusal, with plans one tap away on Android', async () => {
  const extra = { 'POST /faq': () => [403, { error: 'Not on your plan', code: 'plan.feature_off', plan: 't1', feature: 'ai_replies' }] };
  await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes({ extra }) });
  await fireEvent.press(await screen.findByTestId('faq-add'));
  await fireEvent.changeText(screen.getByTestId('faq-question'), 'Q?');
  await fireEvent.changeText(screen.getByTestId('faq-answer'), 'A.');
  await fireEvent.press(screen.getByTestId('faq-save'));
  await screen.findByTestId('upgrade-prompt');
  expect(screenText()).toMatch(/Starter/);
  expect(screen.getByTestId('upgrade-prompt-plans')).toBeTruthy();
});

test('on iOS the prompt names the limit and does not say where to buy', async () => {
  const extra = { 'PATCH /ai-replies': () => [403, { error: 'Not on your plan', code: 'plan.feature_off', plan: 't1', feature: 'ai_replies' }] };
  await openAt('/ai-replies', { list: [aiReplies], platform: 'ios', routes: aiRoutes({ extra }) });
  await fireEvent.press(await screen.findByTestId('ai-enabled'));
  await screen.findByTestId('upgrade-prompt');
  expect(screen.queryByTestId('upgrade-prompt-plans')).toBeNull();
  expect(screenText()).not.toMatch(/see plans|buy|upgrade now/i);
});

test('a test question shows what would be said, from what, and that nothing was sent', async () => {
  const { server } = await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes() });
  await fireEvent.changeText(await screen.findByTestId('ai-test-question'), 'Do you ship to Pune?');
  await fireEvent.press(screen.getByTestId('ai-test-ask'));
  await screen.findByTestId('ai-test-answer');
  const text = screenText();
  expect(text).toMatch(/we ship to Pune in 3 days/);
  expect(text).toMatch(/Would be sent/);
  expect(text).toMatch(/91%/);
  expect(text).toMatch(/Nothing was sent/);
  expect(writes(server).find((c) => c.path === '/ai-replies/test').body).toEqual({ question: 'Do you ship to Pune?' });
});

test('the log shows answers and hand-offs, and a row past retention says its text was removed', async () => {
  await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes() });
  await screen.findByTestId('ai-log-1');
  expect(screenText()).toMatch(/Where is my order\?/);
  expect(screenText()).toMatch(/Handed to team/);
  expect(screenText()).toMatch(/removed after the retention period/);
});

test('a question over the limit cannot be typed', async () => {
  await openAt('/ai-replies', { list: [aiReplies], routes: aiRoutes() });
  expect((await screen.findByTestId('ai-test-question')).props.maxLength).toBe(1000);
});

test('it lists all its routes', () => {
  expect(aiReplies.routeIds).toHaveLength(8);
});
