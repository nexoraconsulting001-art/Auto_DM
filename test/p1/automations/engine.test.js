// What the automations ask compliance to send, for each thing that happens on Instagram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComplianceAction } from '../../../src/contracts/compliance.js';
import { NoTenantError } from '../../../src/tenancy.js';
import { REEL_ID } from '../../helpers.js';
import { DAY, HOUR, LINK, PERSON, REEL, STORY, another, closeWorld, fakeMeta, inWorld, world } from './support.js';

const ACTOR = { actor: 'user:1' };
const story = (extra = {}) => ({ triggerType: 'story_reply', keywords: [], matchMode: 'any', anyModeAcknowledged: true, linkMode: 'one_tap', triggers: [{ targetType: 'story', mediaId: STORY }], ...extra });
const dmRule = (extra = {}) => ({ triggerType: 'dm_keyword', linkUrl: '', keywords: ['price'], triggers: [{ targetType: 'dm' }], ...extra });
const welcome = (extra = {}) => ({ triggerType: 'dm_welcome', keywords: [], matchMode: 'any', linkUrl: '', triggers: [], variants: [{ label: 'A', body: 'Welcome!', quickReplies: [{ title: 'Price', payload: 'price' }] }], ...extra });
const mention = (extra = {}) => ({ triggerType: 'story_mention', keywords: [], matchMode: 'any', triggers: [], ...extra });
const hoursFrom = (dailyStart, dailyEnd, outsideHours = 'hold') => ({ schedule: { startsAt: null, endsAt: null, dailyStart, dailyEnd, outsideHours } });
const asked = (w) => w.compliance.enqueued;

test('A-01: a matching comment on a live reel asks for one private reply, naming the automation', inWorld(async (w) => {
  const automation = await w.create({ linkMode: 'one_tap' });
  assert.equal(await w.handle(await w.events.comment({ id: 'C1' })), true);
  const [{ action, options }, ...rest] = asked(w);
  assert.deepEqual(rest, []);
  assert.equal(action.kind, 'private_reply');
  assert.equal(action.purpose, 'trigger');
  assert.equal(action.idempotencyKey, 'private_reply:C1');
  assert.equal(action.commentId, 'C1');
  assert.equal(action.personId, PERSON);
  assert.equal(action.mediaId, REEL);
  assert.equal(action.automationId, automation.id);
  assert.equal(action.variantId, automation.variants[0].id);
  assert.equal(action.isTest, false);
  assert.deepEqual(options, { trigger: 'comment' });
  assert.equal(ComplianceAction.safeParse(action).success, true);
}));

test('the worker\'s expiry for a comment is the one the job carries', inWorld(async (w) => {
  await w.create({});
  const expiresAt = new Date(w.clock.at + DAY);
  await w.handle(await w.events.comment({ expiresAt }));
  assert.equal(asked(w)[0].action.expiresAt.getTime(), expiresAt.getTime());
}));

test('A-03: media_product_type decides whether a trigger is labelled a post or a reel', inWorld(async (w) => {
  const automation = await w.create({ triggers: [{ targetType: 'reel', mediaId: REEL }] });
  await w.handle(await w.events.comment({ type: 'FEED' }));
  assert.equal((await w.repos.automations.get(automation.id)).triggers[0].targetType, 'post');
  await w.handle(await w.events.comment({ type: 'REELS' }));
  assert.equal((await w.repos.automations.get(automation.id)).triggers[0].targetType, 'reel');
}));

test('A-04: a comment on media with no automation is logged as unmapped and nothing is asked for', inWorld(async (w) => {
  assert.equal(await w.handle(await w.events.comment({ mediaId: 'NOPE' })), true);
  assert.equal(await w.lastReason(), 'unmapped');
  assert.deepEqual(asked(w), []);
}));

test('a Phase 0 reel with no automation is left to the old path, unlogged', inWorld(async (w) => {
  const product = await w.repos.products.create({ name: 'P', price: '100', stock: '', active: 'on' });
  await w.repos.reels.save(REEL_ID, { headline: 'R', keywords: 'price', productIds: [product.id], active: 'on' });
  assert.equal(await w.handle(await w.events.comment({ mediaId: REEL_ID })), false);
  assert.deepEqual(await w.log(), []);
}));

test('comments without the keyword, emoji-only comments and any-comment mode', inWorld(async (w) => {
  await w.create({ keywords: ['price', '🔥'] });
  await w.handle(await w.events.comment({ text: 'nice reel', tooShort: false }));
  assert.equal(await w.lastReason(), 'no_keyword');
  await w.handle(await w.events.comment({ text: '😍😍', tooShort: true }));
  assert.equal(await w.lastReason(), 'too_short');
  await w.handle(await w.events.comment({ text: '🔥🔥', tooShort: true }));
  assert.equal(asked(w).length, 1, 'an emoji keyword still matches');
}));

test('any-comment mode answers any comment with words, and still skips the very short ones', inWorld(async (w) => {
  await w.create({ matchMode: 'any', anyModeAcknowledged: true, keywords: [] });
  await w.handle(await w.events.comment({ text: 'nice reel' }));
  assert.equal(asked(w).length, 1);
  await w.handle(await w.events.comment({ text: '😍' }));
  assert.equal(await w.lastReason(), 'too_short');
}));

test('a draft automation sends nothing, a paused one goes to the gate to be held, and an archived one is gone', inWorld(async (w) => {
  const automation = await w.create({}, 'draft');
  await w.handle(await w.events.comment({}));
  assert.equal(await w.lastReason(), 'automation.draft');
  assert.deepEqual(asked(w), []);
  await w.repos.automations.setState(automation.id, 'live', ACTOR);
  await w.repos.automations.setState(automation.id, 'paused', ACTOR);
  await w.handle(await w.events.comment({ id: 'C-P' }));
  assert.equal(asked(w).at(-1).action.commentId, 'C-P');
  await w.repos.automations.setState(automation.id, 'archived', ACTOR);
  const before = asked(w).length;
  await w.handle(await w.events.comment({}));
  assert.equal(await w.lastReason(), 'unmapped');
  assert.equal(asked(w).length, before);
}));

test('C-55: what is logged about a skip has a hash and no person or words', inWorld(async (w) => {
  await w.handle(await w.events.comment({ mediaId: 'NOPE', username: 'asha_k', text: 'secret words' }));
  const [row] = await w.log();
  assert.match(row.subject, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(row), /asha|secret|P-100/);
}));

test('A-13: a reply to a story with an automation asks for one DM with that story\'s direct link', inWorld(async (w) => {
  const automation = await w.create(story());
  await w.handle(await w.events.storyReply({ mid: 'M1' }));
  const [{ action, options }] = asked(w);
  assert.deepEqual([action.kind, action.purpose, action.recipientId, action.personId, action.automationId, action.mediaId, action.message.button.url], ['dm', 'trigger', PERSON, PERSON, automation.id, STORY, LINK]);
  assert.equal(action.idempotencyKey, 'story_reply:M1');
  assert.deepEqual(options, { trigger: 'story_reply', inReplyTo: 'M1' });
}));

test('A two-tap story automation still sends the link at once: there is no private reply to tap', inWorld(async (w) => {
  await w.create(story({ linkMode: 'two_tap' }));
  await w.handle(await w.events.storyReply({}));
  assert.equal(asked(w)[0].action.message.button.url, LINK);
}));

test('A-14: a story reply with no story automation and no any-story rule is unmapped', inWorld(async (w) => {
  await w.handle(await w.events.storyReply({ storyId: 'OTHER' }));
  assert.equal(await w.lastReason(), 'unmapped');
}));

test('a story with no automation of its own falls back to the any-story rule, and its own beats it', inWorld(async (w) => {
  const any = await w.create(story({ triggers: [{ targetType: 'any_story' }] }));
  await w.handle(await w.events.storyReply({ storyId: 'WHATEVER' }));
  assert.equal(asked(w).at(-1).action.automationId, any.id);
  const own = await w.create(story());
  await w.handle(await w.events.storyReply({}));
  assert.equal(asked(w).at(-1).action.automationId, own.id);
}));

test('A-15: an emoji reaction to a story that excludes reactions gets no DM, and one that includes them does', inWorld(async (w) => {
  const automation = await w.create(story());
  await w.handle(await w.events.storyReply({ text: '😍' }));
  assert.equal(await w.lastReason(), 'no_keyword');
  assert.deepEqual(asked(w), []);
  await w.repos.automations.update(automation.id, { includeReactions: true }, ACTOR);
  await w.handle(await w.events.storyReply({ text: '😍' }));
  assert.equal(asked(w).length, 1);
}));

test('a story automation with keywords only answers them', inWorld(async (w) => {
  await w.create(story({ keywords: ['link'], matchMode: 'keywords' }));
  await w.handle(await w.events.storyReply({ text: 'nice' }));
  assert.equal(await w.lastReason(), 'no_keyword');
  await w.handle(await w.events.storyReply({ text: 'link pls' }));
  assert.equal(asked(w).length, 1);
}));

test('a story reply on a thread a person has taken over gets nothing', inWorld(async (w) => {
  await w.create(story());
  await w.handle(await w.events.storyReply({ threadPaused: 'thread.handoff' }));
  assert.equal(await w.lastReason(), 'thread.handoff');
  assert.deepEqual(asked(w), []);
}));

test('story and DM automations left behind by a downgrade stop', inWorld(async (w) => {
  await w.create(story());
  await w.create(dmRule());
  await w.db.platform.query(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [w.tenant.id]);
  await w.handle(await w.events.storyReply({}));
  assert.equal(await w.lastReason(), 'paused.automation');
  await w.handle(await w.events.dm({ text: 'price' }));
  assert.deepEqual(asked(w), []);
}));

test('A-16: a mention with no recent DM gets none', inWorld(async (w) => {
  await w.create(mention());
  const thread = await w.thread(PERSON, { lastUserAt: null });
  await w.handle(await w.events.mention({ threadId: thread.id }));
  assert.equal(await w.lastReason(), 'mention.no_window');
  assert.deepEqual(asked(w), []);
}));

test('a mention from someone whose last message is older than the window gets none', inWorld(async (w) => {
  await w.create(mention());
  const thread = await w.thread(PERSON, { lastUserAt: new Date(w.clock.at - 24 * HOUR) });
  await w.handle(await w.events.mention({ threadId: thread.id }));
  assert.equal(await w.lastReason(), 'mention.no_window');
}));

test('A-17: a mention from someone who DMed 1h earlier asks for one DM, marked as a mention, ending with that window', inWorld(async (w) => {
  await w.create(mention());
  const last = new Date(w.clock.at - HOUR);
  const thread = await w.thread(PERSON, { lastUserAt: last });
  await w.handle(await w.events.mention({ threadId: thread.id, mid: 'M1' }));
  const [{ action, options }] = asked(w);
  assert.deepEqual([action.kind, action.purpose, action.idempotencyKey], ['dm', 'trigger', 'mention:M1']);
  assert.deepEqual(options, { trigger: 'mention' });
  assert.equal(action.expiresAt.getTime(), last.getTime() + 23 * HOUR + 50 * 60_000);
}));

test('A-19: a DM with no rule to answer it gets the welcome with its quick replies', inWorld(async (w) => {
  await w.create(welcome());
  await w.handle(await w.events.dm({ text: 'hi' }));
  const [{ action }] = asked(w);
  assert.equal(action.purpose, 'welcome');
  assert.equal(action.idempotencyKey, `welcome:${await w.subjectOf(PERSON)}`);
  assert.deepEqual(action.message.quickReplies, [{ title: 'Price', payload: 'price' }]);
}));

test('A-21: when two rules match only the higher priority answers, marked as a reply to that message', inWorld(async (w) => {
  await w.create(dmRule({ priority: 1, variants: [{ label: 'A', body: 'Low' }] }));
  const high = await w.create(dmRule({ priority: 5, variants: [{ label: 'A', body: 'High' }] }));
  await w.handle(await w.events.dm({ text: 'price?', mid: 'M1' }));
  const [{ action, options }, ...rest] = asked(w);
  assert.deepEqual(rest, []);
  assert.deepEqual([action.automationId, action.message.text, action.purpose, action.idempotencyKey], [high.id, 'High', 'faq', 'dm_reply:M1']);
  assert.deepEqual(options, { trigger: 'dm_keyword', inReplyTo: 'M1' });
}));

test('a keyword rule outranks the welcome', inWorld(async (w) => {
  await w.create(welcome());
  await w.create(dmRule());
  await w.handle(await w.events.dm({ text: 'price' }));
  assert.equal(asked(w).length, 1);
  assert.equal(asked(w)[0].action.purpose, 'faq');
}));

test('a DM that matches nothing gets nothing, and the reason is logged', inWorld(async (w) => {
  await w.create(dmRule());
  await w.handle(await w.events.dm({ text: 'hello' }));
  assert.equal(await w.lastReason(), 'no_keyword');
  assert.deepEqual(asked(w), []);
}));

test('C-27: a DM on a thread paused by the owner gets no automated reply', inWorld(async (w) => {
  await w.create(dmRule());
  await w.handle(await w.events.dm({ text: 'price', threadPaused: 'thread.owner_replied' }));
  assert.equal(await w.lastReason(), 'thread.owner_replied');
  assert.deepEqual(asked(w), []);
}));

test('a very long message id still makes a key under the limit', inWorld(async (w) => {
  await w.create(dmRule());
  await w.handle(await w.events.dm({ text: 'price', mid: 'x'.repeat(400) }));
  assert.ok(asked(w)[0].action.idempotencyKey.length <= 200);
  assert.equal(asked(w)[0].options.inReplyTo.length, 400);
}));

test('a quick reply tap is answered by the keyword rules, using what it sends back', inWorld(async (w) => {
  const rule = await w.create(dmRule());
  await w.handle(await w.events.dm({ text: 'Tell me', quickReply: 'price' }));
  assert.equal(asked(w)[0].action.automationId, rule.id);
}));

test('a postback that isn\'t an ice breaker is answered by the keyword rules too', inWorld(async (w) => {
  const rule = await w.create(dmRule({ keywords: ['faq:sizes'] }));
  await w.handle(await w.events.postback({ payload: 'faq:sizes' }));
  assert.equal(asked(w)[0].action.automationId, rule.id);
}));

test('an ice breaker tap gets its answer, and a tap on one that is gone gets nothing', inWorld(async (w) => {
  await w.repos.iceBreakers.save([{ question: 'Do you ship?', templateBody: 'Yes, all over India' }], ACTOR);
  await w.handle(await w.events.postback({ payload: 'faq:1', mid: 'M1' }));
  const [{ action, options }] = asked(w);
  assert.deepEqual([action.purpose, action.message.text, action.idempotencyKey], ['faq', 'Yes, all over India', 'dm_reply:M1']);
  assert.deepEqual(options, { inReplyTo: 'M1' });
  await w.handle(await w.events.postback({ payload: 'faq:2' }));
  assert.equal(await w.lastReason(), 'unmapped');
}));

test('a two-tap tap is left for the links track', inWorld(async (w) => {
  assert.equal(await w.handle(await w.events.postback({ payload: 'two_tap:1:2:M:C' })), false);
  assert.deepEqual(await w.log(), []);
}));

test('A-25, A-67: on a two-tap automation the first DM is a postback button with no address in it', inWorld(async (w) => {
  const automation = await w.create({ variants: [{ label: 'A', body: 'Tap below and I\'ll send it' }] });
  await w.handle(await w.events.comment({ id: 'C1' }));
  const [{ action }] = asked(w);
  assert.deepEqual(action.message.button, { payload: `two_tap:${automation.id}:${action.variantId}:${REEL}:C1`, title: 'Send me the link' });
  assert.doesNotMatch(JSON.stringify(action.message), /https?:/);
}));

test('A-25: on a one-tap automation the first DM\'s button opens the direct link, and the button text is the owner\'s', inWorld(async (w) => {
  await w.create({ linkMode: 'one_tap', variants: [{ label: 'A', body: 'See it: {url}', buttonTitle: 'See it' }] });
  await w.handle(await w.events.comment({}));
  const { message } = asked(w)[0].action;
  assert.deepEqual(message.button, { url: LINK, title: 'See it' });
  assert.equal(message.text, `See it: ${LINK}`);
}));

test('A-72: changing the button text changes new DMs', inWorld(async (w) => {
  const automation = await w.create({});
  await w.repos.automations.update(automation.id, { tapButtonTitle: 'Get the link' }, ACTOR);
  await w.handle(await w.events.comment({}));
  assert.equal(asked(w)[0].action.message.button.title, 'Get the link');
}));

test('a plan without one tap gets two taps at send, even if the automation says one tap', inWorld({ plan: 'free' }, async (w) => {
  await w.create({ linkMode: 'one_tap' });
  await w.handle(await w.events.comment({}));
  assert.ok(asked(w)[0].action.message.button.payload);
}));

test('A-26: the fallback goes with the job, filled in', inWorld({ meta: fakeMeta({ people: { 'P-KNOWN': { name: 'Asha K' } } }) }, async (w) => {
  await w.create({ linkMode: 'one_tap', variants: [{ label: 'A', body: 'Here', fallbackText: 'Hi {first_name}: {url}' }] });
  await w.handle(await w.events.comment({ from: 'P-KNOWN' }));
  assert.equal(asked(w)[0].options.fallbackText, `Hi Asha: ${LINK}`);
}));

test('A-28: with no name available the DM still reads correctly, and with one it is used', inWorld({ meta: fakeMeta({ people: { 'P-KNOWN': { name: 'Asha Kumar' } } }) }, async (w) => {
  await w.create({ linkMode: 'one_tap', variants: [{ label: 'A', body: 'Hi {first_name}, here it is' }] });
  await w.handle(await w.events.comment({ from: 'P-KNOWN' }));
  await w.handle(await w.events.comment({ from: 'P-UNKNOWN' }));
  assert.deepEqual(asked(w).map((a) => a.action.message.text), ['Hi Asha, here it is', 'Hi, here it is']);
}));

test('A-28: when the profile lookup fails the DM still goes, and a name holding template syntax stays as written', async () => {
  const meta = { client: { forAccount: () => ({ getPerson: async (id) => { if (id === 'P-BAD') throw new Error('nope'); return { name: '{url}' }; } }) } };
  const w = await world({ meta });
  try {
    await w.create({ linkMode: 'one_tap', variants: [{ label: 'A', body: 'Hi {first_name}, here it is' }] });
    await w.handle(await w.events.comment({ from: 'P-BAD' }));
    await w.handle(await w.events.comment({ from: 'P-SYNTAX' }));
    assert.deepEqual(asked(w).map((a) => a.action.message.text), ['Hi, here it is', 'Hi {url}, here it is']);
  } finally {
    await closeWorld(w);
  }
});

test('A-29: two versions split about evenly, and a person always gets the same one', inWorld(async (w) => {
  await w.create({ variants: [{ label: 'A', body: 'Version A' }, { label: 'B', body: 'Version B' }] });
  for (let i = 0; i < 200; i++) await w.handle(await w.events.comment({ from: `P${i}` }));
  const a = asked(w).filter(({ action }) => action.message.text === 'Version A').length;
  assert.equal(asked(w).length, 200);
  assert.ok(a > 70 && a < 130, `A got ${a}`);
  await w.handle(await w.events.comment({ from: 'P0' }));
  assert.equal(asked(w).at(-1).action.variantId, asked(w)[0].action.variantId);
}));

test('A-30: after the owner picks a winner all new sends use it', inWorld(async (w) => {
  const automation = await w.create({ variants: [{ label: 'A', body: 'Version A' }, { label: 'B', body: 'Version B' }] });
  const b = automation.variants.find((v) => v.label === 'B');
  await w.repos.automations.pickWinner(automation.id, b.id, ACTOR);
  for (let i = 0; i < 20; i++) await w.handle(await w.events.comment({ from: `P${i}` }));
  assert.deepEqual([...new Set(asked(w).map(({ action }) => action.variantId))], [b.id]);
}));

test('A-74: a free-plan DM has no Bhava name, link or badge in it', inWorld({ plan: 'free' }, async (w) => {
  await w.create({});
  await w.handle(await w.events.comment({}));
  assert.doesNotMatch(JSON.stringify(asked(w)), /bhava|powered by/i);
}));

test('A-47: a comment outside hours is created held, and released when the hours arrive', inWorld(async (w) => {
  w.clock.at = new Date('2026-11-09T23:00:00+05:30').getTime();
  await w.create(hoursFrom('09:00', '21:00'));
  await w.handle(await w.events.comment({ id: 'C1' }));
  const [{ options, action }] = asked(w);
  assert.equal(options.runAt.getTime(), action.expiresAt.getTime(), 'no worker can take it before it is marked held');
  let [job] = await w.jobs();
  assert.deepEqual([job.status, job.reason], ['held', 'outside_hours']);
  assert.equal((await w.log()).at(-1).decision, 'held');

  w.clock.at = new Date('2026-11-10T08:59:00+05:30').getTime();
  await w.engine.housekeeping();
  [job] = await w.jobs();
  assert.equal(job.status, 'held', 'not before the hours');

  w.clock.at = new Date('2026-11-10T09:05:00+05:30').getTime();
  await w.engine.housekeeping();
  [job] = await w.jobs();
  assert.deepEqual([job.status, job.reason], ['queued', '']);
  assert.equal(new Date(job.run_at).getTime(), w.clock.at, 'it can go now');
}));

test('A-47: changing the hours to include now releases what is held', inWorld(async (w) => {
  w.clock.at = new Date('2026-11-09T23:00:00+05:30').getTime();
  const automation = await w.create(hoursFrom('09:00', '21:00'));
  await w.handle(await w.events.comment({}));
  await w.repos.automations.update(automation.id, hoursFrom('22:00', '23:30'), ACTOR);
  await w.engine.housekeeping();
  assert.equal((await w.jobs())[0].status, 'queued');
}));

test('outside hours in skip mode nothing is created', inWorld(async (w) => {
  w.clock.at = new Date('2026-11-09T23:00:00+05:30').getTime();
  await w.create(hoursFrom('09:00', '21:00', 'skip'));
  await w.handle(await w.events.comment({}));
  assert.equal(await w.lastReason(), 'outside_hours');
  assert.deepEqual(asked(w), []);
}));

test('a comment that would expire before the hours arrive isn\'t held', inWorld(async (w) => {
  w.clock.at = new Date('2026-11-09T23:00:00+05:30').getTime();
  await w.create(hoursFrom('09:00', '21:00'));
  await w.handle(await w.events.comment({ expiresAt: new Date(w.clock.at + HOUR) }));
  assert.equal(await w.lastReason(), 'outside_hours');
  assert.deepEqual(asked(w), []);
}));

test('before the start time a comment is held, and after the end time nothing is created and the automation moves to Paused', inWorld(async (w) => {
  const start = new Date(w.clock.at + HOUR).toISOString();
  const end = new Date(w.clock.at + 2 * HOUR).toISOString();
  const automation = await w.create({ schedule: { startsAt: start, endsAt: end, dailyStart: null, dailyEnd: null, outsideHours: 'hold' } });
  await w.handle(await w.events.comment({}));
  assert.equal((await w.jobs())[0].status, 'held');
  w.clock.at += 3 * HOUR;
  const before = asked(w).length;
  await w.handle(await w.events.comment({}));
  assert.equal(await w.lastReason(), 'paused.automation');
  assert.equal(asked(w).length, before);
  await w.engine.housekeeping();
  assert.equal((await w.repos.automations.get(automation.id)).state, 'paused');
}));

test('A-49: in Test a tester gets a real DM marked not to be counted', inWorld(async (w) => {
  await w.create({}, 'test');
  await w.addTester();
  await w.handle(await w.events.comment({}));
  assert.equal(asked(w)[0].action.isTest, true);
}));

test('A-50: in Test anyone else gets nothing', inWorld(async (w) => {
  await w.create({}, 'test');
  await w.addTester('P-TESTER');
  await w.handle(await w.events.comment({ from: 'P-STRANGER' }));
  assert.equal(await w.lastReason(), 'test_mode');
  assert.deepEqual(asked(w), []);
}));

test('a tester on a live automation is sent to and not counted, and a dry run is never counted', inWorld(async (w) => {
  await w.create({});
  await w.create({ dryRun: true, triggers: [{ targetType: 'reel', mediaId: 'R2' }] });
  await w.addTester();
  await w.handle(await w.events.comment({}));
  assert.equal(asked(w)[0].action.isTest, true);
  await w.handle(await w.events.comment({ from: 'P-X', mediaId: 'R2' }));
  assert.equal(asked(w)[1].action.isTest, true);
}));

test('a test DM rule is skipped for strangers, so a live rule below it still answers', inWorld(async (w) => {
  await w.create(dmRule({ priority: 9, variants: [{ label: 'A', body: 'Test only' }] }), 'test');
  const live = await w.create(dmRule({ priority: 1, variants: [{ label: 'A', body: 'Live' }] }));
  await w.handle(await w.events.dm({ text: 'price' }));
  assert.equal(asked(w)[0].action.automationId, live.id);
}));

test('a test DM rule with nothing else matching reports test_mode', inWorld(async (w) => {
  await w.create(dmRule(), 'test');
  await w.handle(await w.events.dm({ text: 'price' }));
  assert.equal(await w.lastReason(), 'test_mode');
}));

test('A-52: a tester who DMs the code within 15 minutes is added by their id', inWorld(async (w) => {
  const { code, expiresAt } = await w.repos.testers.createCode({ ...ACTOR, label: 'Priya phone', now: new Date(w.clock.at) });
  assert.equal(new Date(expiresAt).getTime(), w.clock.at + 15 * 60_000);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  w.clock.at += 14 * 60_000;
  await w.handle(await w.events.dm({ from: 'P-T', text: ` ${code.toLowerCase()} ` }));
  const { items } = await w.repos.testers.list({ limit: 5, now: new Date(w.clock.at) });
  assert.deepEqual([items.length, items[0].label, items[0].channel, items[0].windowOpen], [1, 'Priya phone', 'instagram', true]);
  const [row] = await w.db.platform.query('SELECT recipient_id FROM testers');
  assert.equal(row.recipient_id, 'P-T');
  const [stored] = await w.db.platform.query('SELECT code_hash FROM tester_codes');
  assert.ok(!stored.code_hash.includes(code.replace('-', '')), 'only a hash is kept');
}));

test('A-53: a code DMed after 16 minutes adds nobody, and a code works once', inWorld(async (w) => {
  const late = await w.repos.testers.createCode({ ...ACTOR, now: new Date(w.clock.at) });
  w.clock.at += 16 * 60_000;
  await w.handle(await w.events.dm({ from: 'P-LATE', text: late.code }));
  assert.equal((await w.repos.testers.list({ limit: 5 })).items.length, 0);

  const once = await w.repos.testers.createCode({ ...ACTOR, now: new Date(w.clock.at) });
  await w.handle(await w.events.dm({ from: 'P-FIRST', text: once.code }));
  await w.handle(await w.events.dm({ from: 'P-SECOND', text: once.code }));
  assert.equal((await w.repos.testers.list({ limit: 5 })).items.length, 1);
}));

test('a tester code never reaches the keyword rules or the welcome, and works on a paused thread', inWorld(async (w) => {
  await w.create(welcome());
  const { code } = await w.repos.testers.createCode({ ...ACTOR, now: new Date(w.clock.at) });
  await w.handle(await w.events.dm({ text: code, threadPaused: 'thread.handoff' }));
  assert.deepEqual(asked(w), []);
  assert.equal((await w.repos.testers.list({ limit: 5 })).items.length, 1);
}));

test('a code from one business does nothing at another', inWorld(async (w) => {
  const b = await another(w, 'beta-shop');
  const { code } = await w.repos.testers.createCode({ ...ACTOR, now: new Date(w.clock.at) });
  await b.handle(await b.events.dm({ text: code }));
  assert.equal((await b.repos.testers.list({ limit: 5 })).items.length, 0);
}));

test('Send test goes to a tester whose window is open, through send(), and reports a closed window', inWorld(async (w) => {
  const automation = await w.create({ linkMode: 'one_tap' });
  await w.addTester();
  const [tester] = await w.db.platform.query('SELECT * FROM testers');
  const result = await w.inBusiness(() => w.engine.sendTest(automation, tester));
  assert.equal(result.outcome, 'sent');
  const [action] = w.compliance.sent;
  assert.deepEqual([action.kind, action.purpose, action.recipientId, action.isTest, action.message.button.url], ['dm', 'test', PERSON, true, LINK]);
  w.clock.at += 24 * HOUR;
  assert.deepEqual(await w.inBusiness(() => w.engine.sendTest(automation, tester)), { outcome: 'skipped', reason: 'window.closed' });
  assert.equal(await w.inBusiness(() => w.engine.sendTest(automation, tester, 'C')).then((r) => r.reason), 'window.closed');
}));

test('C-21: a reply to our DM asks for one follow-up at least 30 minutes later, inside the window', inWorld(async (w) => {
  const automation = await w.create({ followupEnabled: true, followupText: 'Still interested?', followupDelayMinutes: 45 });
  await w.handle(await w.events.comment({}));
  await w.db.platform.query(`UPDATE outbound_jobs SET status = 'sent', sent_at = $1`, [new Date(w.clock.at)]);
  w.clock.at += 60_000;
  await w.handle(await w.events.dm({ text: 'thanks' }));
  await w.handle(await w.events.dm({ text: 'one more' }));
  const followups = asked(w).filter(({ action }) => action.purpose === 'followup');
  assert.equal(followups.length, 1, 'one per person per automation');
  const [{ action, options }] = followups;
  assert.deepEqual([action.automationId, action.kind, action.recipientId, action.message.text], [automation.id, 'dm', PERSON, 'Still interested?']);
  assert.equal(options.runAt.getTime(), w.clock.at + 45 * 60_000);
  assert.equal(action.expiresAt.getTime(), w.clock.at + 23 * HOUR + 50 * 60_000);
}));

test('C-20: with no reply there is no follow-up, nor from a DM that came before ours', inWorld(async (w) => {
  await w.create({ followupEnabled: true, followupText: 'Still interested?' });
  await w.handle(await w.events.comment({}));
  await w.handle(await w.events.dm({ text: 'before it was sent' }));
  assert.equal(asked(w).filter(({ action }) => action.purpose === 'followup').length, 0);
}));

test('no follow-up for an automation without one, or once it is no longer running', inWorld(async (w) => {
  const automation = await w.create({ followupEnabled: true, followupText: 'Still?' });
  await w.handle(await w.events.comment({}));
  await w.db.platform.query(`UPDATE outbound_jobs SET status = 'sent', sent_at = now() - interval '1 minute'`);
  await w.repos.automations.setState(automation.id, 'paused', ACTOR);
  await w.handle(await w.events.dm({ text: 'thanks' }));
  assert.equal(asked(w).filter(({ action }) => action.purpose === 'followup').length, 0);
}));

test('one business\'s automation never answers another\'s comment on the same media id', inWorld(async (w) => {
  const b = await another(w, 'beta-shop');
  await w.create({});
  await b.handle(await b.events.comment({ id: 'B1' }));
  assert.equal(await b.lastReason(), 'unmapped');
  assert.deepEqual([asked(w).length, asked(b).length], [0, 0]);
  await assert.rejects(() => w.platform.automations.get(1), NoTenantError);
  await assert.rejects(() => w.platform.inbox.listThreads({ limit: 1 }), NoTenantError);
  await assert.rejects(() => w.platform.testers.isTester('instagram', 'x'), NoTenantError);
}));

test('a tester in one business is a stranger in another', inWorld(async (w) => {
  const b = await another(w, 'beta-shop');
  await w.addTester();
  await b.create({}, 'test');
  await b.handle(await b.events.comment({}));
  assert.equal(await b.lastReason(), 'test_mode');
}));

test('housekeeping releases one business\'s held jobs and not another\'s still outside its hours', inWorld(async (w) => {
  const b = await another(w, 'beta-shop');
  await b.db.platform.query(`UPDATE tenants SET timezone = 'UTC' WHERE id = $1`, [b.tenant.id]);
  const late = new Date('2026-11-09T22:00:00+05:30').getTime();
  w.clock.at = late;
  b.clock.at = late;
  await w.create(hoursFrom('09:00', '21:00'));
  await b.create(hoursFrom('09:00', '21:00'));
  await w.handle(await w.events.comment({}));
  await b.handle(await b.events.comment({}));
  assert.equal((await w.jobs())[0].status, 'held');
  assert.equal((await b.jobs()).length, 1, 'inside hours there: 16:30 UTC');
  assert.equal((await b.jobs())[0].status, 'queued');
  await w.db.platform.query(`UPDATE outbound_jobs SET status = 'held', reason = 'outside_hours' WHERE tenant_id = $1`, [b.tenant.id]);
  await b.db.platform.query(`UPDATE automations SET daily_start = '01:00', daily_end = '02:00' WHERE tenant_id = $1`, [b.tenant.id]);
  w.clock.at = new Date('2026-11-10T10:00:00+05:30').getTime();
  await w.engine.housekeeping();
  assert.equal((await w.jobs())[0].status, 'queued');
  assert.equal((await b.jobs())[0].status, 'held');
}));

test('retention empties the inbox\'s names and words after 30 days, and leaves newer ones', inWorld(async (w) => {
  const old = await w.thread('P-OLD');
  await w.db.platform.query(`INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, text, created_at) VALUES ($1, $2, 'in', 'person', 'old words', now() - interval '31 days')`, [w.tenant.id, old.id]);
  await w.db.platform.query(`UPDATE inbox_threads SET last_message_at = now() - interval '31 days', last_user_message_at = now() - interval '31 days' WHERE id = $1`, [old.id]);
  await w.db.platform.query(`INSERT INTO needs_human_items (tenant_id, channel, kind, username, text, created_at) VALUES ($1, 'instagram', 'negative_comment', 'asha', 'old', now() - interval '31 days')`, [w.tenant.id]);
  const fresh = await w.thread('P-NEW');
  await w.db.platform.query(`INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, text) VALUES ($1, $2, 'in', 'person', 'new words')`, [w.tenant.id, fresh.id]);
  await w.engine.housekeeping({ retention: true });
  assert.deepEqual((await w.db.platform.query('SELECT text FROM inbox_messages')).map((m) => m.text), ['new words']);
  assert.deepEqual(await w.db.platform.query('SELECT username, text FROM needs_human_items'), [{ username: '', text: '' }]);
  const [thread] = await w.db.platform.query('SELECT username, last_message FROM inbox_threads WHERE id = $1', [old.id]);
  assert.deepEqual(thread, { username: '', last_message: '' });
}));

test('the module takes events from the compliance worker', inWorld(async (w) => {
  await w.create({});
  assert.equal(await w.viaModule(await w.events.comment({})), true);
  assert.equal(asked(w).length, 1);
}));

test('an event of a kind the module doesn\'t answer is left alone', inWorld(async (w) => {
  await w.create(welcome());
  assert.equal(await w.handle({ type: 'post_mention', channel: 'instagram', accountId: 'x', subject: '', mediaId: 'm', text: '' }), false);
  assert.equal(await w.handle({ ...await w.events.dm({}), type: 'attachment' }), false);
  assert.deepEqual(asked(w), []);
}));

test('a job the gate held for a pause is marked for its hours as well', async () => {
  const w = await world();
  try {
    w.clock.at = new Date('2026-11-09T23:00:00+05:30').getTime();
    await w.create(hoursFrom('09:00', '21:00'));
    const enqueue = w.compliance.enqueue;
    w.compliance.enqueue = async (...args) => {
      const result = await enqueue(...args);
      await w.db.platform.query(`UPDATE outbound_jobs SET status = 'held', reason = 'paused.tenant' WHERE id = $1`, [result.jobId]);
      return { ...result, outcome: 'held', reason: 'paused.tenant' };
    };
    await w.handle(await w.events.comment({}));
    assert.equal((await w.jobs())[0].reason, 'outside_hours');
  } finally {
    await closeWorld(w);
  }
});

test('nothing runs outside a business', async () => {
  const w = await world();
  try {
    const event = await w.events.comment({});
    await assert.rejects(() => w.engine.handle(event), NoTenantError);
  } finally {
    await closeWorld(w);
  }
});
