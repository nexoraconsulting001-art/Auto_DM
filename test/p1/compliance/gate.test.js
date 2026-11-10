// The rules as a pure function, so each edge can be stood on exactly: PRD 4.3 to 4.5 and 4.12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS as limits } from '../../../src/contracts/compliance.js';
import { budgetMultiplier, callAllowed, evaluate, evaluateCreation, expiryReason, slowModeActive, triggerOf } from '../../../src/modules/compliance/gate.js';
import { DAY, HOUR, MINUTE } from './support.js';

const at = Date.parse('2026-11-01T10:00:00Z');
const FAR = new Date(at + 6 * DAY);
const open = () => ({ account: { token: 't', status: 'active' }, thread: { lastUserMessageAt: new Date(at - HOUR) }, optedOut: false, disclosureEnabled: false });
const base = (kind, extra = {}) => ({ kind, purpose: 'trigger', channel: 'instagram', accountId: 'A', idempotencyKey: 'k', expiresAt: FAR, message: { text: 'hello' }, ...extra });
const verdict = (action, state = open(), options = {}) => {
  const { allow, outcome, reason } = evaluate(action, state, { at, limits, ...options });
  return { allow, outcome, reason };
};
const says = (outcome, reason, allow = false) => ({ allow, outcome, reason });
const OK = says('queued', '', true);

test('a private reply one millisecond before it expires still goes', () => {
  assert.deepEqual(verdict(base('private_reply', { expiresAt: new Date(at + 1) })), OK);
});

test('C-14: at the moment it expires a private reply is dropped', () => {
  assert.deepEqual(verdict(base('private_reply', { expiresAt: new Date(at) })), says('expired', 'expired.7d'));
});

test('each kind has its own expiry reason', () => {
  assert.equal(expiryReason({ kind: 'private_reply' }), 'expired.7d');
  assert.equal(expiryReason({ kind: 'public_reply' }), 'expired.public_reply');
  assert.equal(expiryReason({ kind: 'dm' }), 'window.closed');
});

test('C-18: the messaging window is 23h50m, to the millisecond', () => {
  const window = (ms) => ({ ...open(), thread: { lastUserMessageAt: new Date(at - ms) } });
  assert.deepEqual(verdict(base('dm'), window(limits.messagingWindowMs - 1)), OK);
  assert.deepEqual(verdict(base('dm'), window(limits.messagingWindowMs)), says('skipped', 'window.closed'));
  assert.deepEqual(verdict(base('dm'), window(25 * HOUR)), says('skipped', 'window.closed'));
});

test('a person who has never messaged can\'t be sent a DM: no cold DMs', () => {
  assert.deepEqual(verdict(base('dm'), { ...open(), thread: null }), says('skipped', 'window.closed'));
});

test('C-19: a mention with no window says why', () => {
  assert.deepEqual(verdict(base('dm'), { ...open(), thread: null }, { trigger: 'mention' }), says('skipped', 'mention.no_window'));
});

test('a private reply needs no window', () => {
  assert.deepEqual(verdict(base('private_reply'), { ...open(), thread: null }), OK);
});

test('C-20: a follow-up with no reply after our DM is blocked', () => {
  const dmAt = new Date(at - 2 * HOUR);
  assert.deepEqual(verdict(base('dm', { purpose: 'followup' }), { ...open(), lastAutomationDmAt: dmAt, thread: { lastUserMessageAt: new Date(at - 3 * HOUR) } }), says('skipped', 'followup.no_response'));
  assert.deepEqual(verdict(base('dm', { purpose: 'followup' }), { ...open(), thread: null, lastAutomationDmAt: dmAt }), says('skipped', 'followup.no_response'));
  assert.deepEqual(verdict(base('dm', { purpose: 'followup' }), { ...open(), lastAutomationDmAt: null }), says('skipped', 'followup.no_response'));
});

test('C-21: a follow-up waits until 30 minutes after their reply, and no longer than the window', () => {
  const dmAt = new Date(at - 2 * DAY);
  const after = (ms) => ({ ...open(), lastAutomationDmAt: dmAt, thread: { lastUserMessageAt: new Date(at - ms) } });
  const early = evaluate(base('dm', { purpose: 'followup' }), after(29 * MINUTE), { at, limits });
  assert.equal(early.outcome, 'queued');
  assert.equal(early.allow, false);
  assert.equal(+early.retryAt, at + MINUTE);
  assert.deepEqual(verdict(base('dm', { purpose: 'followup' }), after(30 * MINUTE)), OK);
  assert.deepEqual(verdict(base('dm', { purpose: 'followup' }), after(limits.messagingWindowMs)), says('skipped', 'window.closed'));
});

test('switches are checked broadest first, so the log names what really stopped it', () => {
  const all = { ...open(), globalKill: true, tenantPaused: true, breakerBlocks: true, automation: { state: 'paused' }, optedOut: true };
  const action = base('dm', { automationId: 1 });
  assert.deepEqual(verdict(action, all), says('held', 'paused.global'));
  assert.deepEqual(verdict(action, { ...all, globalKill: false }), says('held', 'paused.tenant'));
  assert.deepEqual(verdict(action, { ...all, globalKill: false, tenantPaused: false, account: { token: '', status: 'active' } }), says('held', 'paused.reconnect'));
  assert.deepEqual(verdict(action, { ...all, globalKill: false, tenantPaused: false, account: { token: 't', status: 'reconnect_needed' } }), says('held', 'paused.reconnect'));
  assert.deepEqual(verdict(action, { ...all, globalKill: false, tenantPaused: false }), says('held', 'paused.breaker'));
  assert.deepEqual(verdict(action, { ...all, globalKill: false, tenantPaused: false, breakerBlocks: false }), says('held', 'paused.automation'));
  assert.deepEqual(verdict(action, { ...all, globalKill: false, tenantPaused: false, breakerBlocks: false, automation: { state: 'live' } }), says('skipped', 'optout'));
});

test('an account that isn\'t this business\'s is held, not sent', () => {
  assert.deepEqual(verdict(base('dm'), { ...open(), account: null }), says('held', 'paused.reconnect'));
});

test('the blocklist stops automation and never a person\'s own conversation with the owner', () => {
  const blocked = { ...open(), optedOut: true };
  assert.deepEqual(verdict(base('dm'), blocked), says('skipped', 'optout'));
  assert.deepEqual(verdict(base('dm', { purpose: 'manual' }), blocked), OK);
  assert.deepEqual(verdict(base('dm', { purpose: 'optout_confirm' }), blocked), OK);
});

test('a paused thread stops automation until its time is up', () => {
  const paused = (ms, reason = 'thread.owner_replied') => ({ ...open(), thread: { lastUserMessageAt: new Date(at - HOUR), pausedUntil: new Date(at + ms), pauseReason: reason } });
  assert.deepEqual(verdict(base('dm'), paused(MINUTE)), says('skipped', 'thread.owner_replied'));
  assert.deepEqual(verdict(base('dm'), paused(MINUTE, 'thread.handoff')), says('skipped', 'thread.handoff'));
  assert.deepEqual(verdict(base('dm'), paused(0)), OK);
  assert.deepEqual(verdict(base('dm', { purpose: 'manual' }), paused(MINUTE)), OK);
});

test('a message that breaks a content rule fails at send, with the disclosure counted', () => {
  assert.deepEqual(verdict(base('private_reply', { message: { text: 'OTP bhejiye' } })), says('failed', 'content.financial_request'));
  assert.deepEqual(verdict(base('private_reply', { message: { text: 'a'.repeat(995) } }), { ...open(), disclosureEnabled: true }), says('failed', 'content.too_long'));
  assert.deepEqual(verdict(base('private_reply', { message: { text: 'a'.repeat(995) } })), OK);
});

test('C-10: a paused account waits without leaving the queue', () => {
  const until = new Date(at + MINUTE);
  const state = { ...open(), rate: { messagingPausedUntil: until } };
  const result = evaluate(base('dm'), state, { at, limits });
  assert.deepEqual([result.allow, result.outcome, result.reason, +result.retryAt], [false, 'queued', 'rate.throttled', +until]);
});

test('slow mode pauses public replies and spaces DMs on one media by 2 minutes', () => {
  const rate = { slowModeUntil: new Date(at + HOUR), startedAt: new Date(at - HOUR) };
  assert.deepEqual(verdict(base('public_reply', { commentId: 'c' }), { ...open(), rate }), says('held', 'rate.slow_mode'));
  assert.equal(evaluate(base('dm'), { ...open(), rate, lastMediaDmAt: new Date(at - MINUTE) }, { at, limits }).reason, 'rate.slow_mode');
  assert.deepEqual(verdict(base('dm'), { ...open(), rate, lastMediaDmAt: new Date(at - 2 * MINUTE) }), OK);
});

test('an override ends slow mode only for the trip it was given for', () => {
  const rate = { slowModeUntil: new Date(at + HOUR), startedAt: new Date(at - HOUR) };
  assert.equal(slowModeActive(rate, at), true);
  assert.equal(slowModeActive({ ...rate, overrideAt: new Date(at - MINUTE) }, at), false);
  assert.equal(slowModeActive({ ...rate, overrideAt: new Date(at - 2 * HOUR) }, at), true, 'an old override does not count');
  assert.equal(slowModeActive({ slowModeUntil: new Date(at - 1) }, at), false);
});

test('multipliers don\'t stack: the lowest applies', () => {
  const slow = { slowModeUntil: new Date(at + HOUR), startedAt: new Date(at - HOUR) };
  assert.equal(budgetMultiplier({}, at, limits), 1);
  assert.equal(budgetMultiplier({ rate: slow }, at, limits), 0.5);
  assert.equal(budgetMultiplier({ scoreReviewNeeded: true }, at, limits), 0.5);
  assert.equal(budgetMultiplier({ breaker: { reducedUntil: new Date(at + 1) } }, at, limits), 0.5);
  assert.equal(budgetMultiplier({ rate: slow, scoreReviewNeeded: true, breaker: { reducedUntil: new Date(at + 1) } }, at, limits), 0.5);
  assert.equal(budgetMultiplier({ breaker: { reducedUntil: new Date(at) } }, at, limits), 1);
});

test('after slow mode ends, sending restores at 75% for 48 hours, then 100%', () => {
  const ended = { rate: { slowModeUntil: new Date(at - 1), startedAt: new Date(at - DAY) } };
  assert.equal(budgetMultiplier(ended, at, limits), 0.75);
  assert.equal(budgetMultiplier(ended, at + 48 * HOUR - 2, limits), 0.75);
  assert.equal(budgetMultiplier(ended, at + 48 * HOUR, limits), 1);
});

test('C-12: at 75% usage non-story insights, public replies and the media list pause; messaging and story insights do not', () => {
  const rate = { usagePercent: 78, usageAt: new Date(at - MINUTE) };
  for (const cls of ['insights', 'public_reply', 'media_list']) assert.equal(callAllowed(rate, cls, at).allow, false, cls);
  for (const cls of ['story_insights', 'comment_timestamp', 'token_refresh', 'subscribed_apps']) assert.equal(callAllowed(rate, cls, at).allow, true, cls);
});

test('C-13: at 90% only token refresh and subscribed_apps run', () => {
  const rate = { usagePercent: 92, usageAt: new Date(at - MINUTE) };
  for (const cls of ['insights', 'public_reply', 'media_list', 'story_insights', 'comment_timestamp']) assert.equal(callAllowed(rate, cls, at).allow, false, cls);
  assert.equal(callAllowed(rate, 'token_refresh', at).allow, true);
  assert.equal(callAllowed(rate, 'subscribed_apps', at).allow, true);
});

test('a usage reading too old to mean anything stops counting, or nothing would ever refresh it', () => {
  assert.equal(callAllowed({ usagePercent: 92, usageAt: new Date(at - 6 * MINUTE) }, 'insights', at).allow, true);
});

test('C-11: 80002 pauses everything but messaging until the regain time', () => {
  const rate = { otherPausedUntil: new Date(at + MINUTE) };
  assert.deepEqual(callAllowed(rate, 'insights', at).reason, 'rate.usage_header');
  assert.equal(callAllowed(rate, 'token_refresh', at).allow, true);
  assert.equal(callAllowed(rate, 'insights', at + MINUTE).allow, true);
  assert.deepEqual(verdict(base('dm'), { ...open(), rate }), OK);
});

test('at creation a paused business still gets its job, as held, with the blocklist applied first', () => {
  const state = { ...open(), tenantPaused: true };
  assert.deepEqual(evaluateCreation(base('dm'), state, { at, limits }), { status: 'held', reason: 'paused.tenant' });
  assert.deepEqual(evaluateCreation(base('dm'), { ...state, optedOut: true }, { at, limits }).terminal.reason, 'optout');
  assert.deepEqual(evaluateCreation(base('dm'), open(), { at, limits }), { status: 'queued', reason: '' });
});

test('creation doesn\'t check the window: that is a fact about the moment of sending', () => {
  assert.deepEqual(evaluateCreation(base('dm'), { ...open(), thread: null }, { at, limits }), { status: 'queued', reason: '' });
});

test('slow mode holds an automation made since it began for review, and lets live ones carry on', () => {
  const rate = { slowModeUntil: new Date(at + HOUR), startedAt: new Date(at - HOUR) };
  const automation = (createdAgo) => ({ state: 'live', created_at: new Date(at - createdAgo) });
  assert.deepEqual(evaluateCreation(base('private_reply', { automationId: 1 }), { ...open(), rate, automation: automation(MINUTE) }, { at, limits }), { status: 'held', reason: 'held.review' });
  assert.deepEqual(evaluateCreation(base('private_reply', { automationId: 1 }), { ...open(), rate, automation: automation(2 * HOUR) }, { at, limits }), { status: 'queued', reason: '' });
  assert.deepEqual(evaluateCreation(base('private_reply'), { ...open(), rate }, { at, limits }), { status: 'queued', reason: '' });
  assert.deepEqual(evaluateCreation(base('public_reply', { commentId: 'c' }), { ...open(), rate }, { at, limits }), { status: 'held', reason: 'rate.slow_mode' });
});

test('a trigger is what the caller says, or the start of its key', () => {
  assert.equal(triggerOf({ idempotencyKey: 'mention:1' }), 'mention');
  assert.equal(triggerOf({ idempotencyKey: 'story_mention:1' }), 'mention');
  assert.equal(triggerOf({ idempotencyKey: 'story_reply:1' }), 'story_reply');
  assert.equal(triggerOf({ idempotencyKey: 'dm_reply:1' }), 'dm_keyword');
  assert.equal(triggerOf({ idempotencyKey: 'x' }), '');
  assert.equal(triggerOf({ idempotencyKey: 'x' }, { trigger: 'mention' }), 'mention');
});
