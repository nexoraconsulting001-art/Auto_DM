// The automation builder's form: its checks, and that what it sends is what the API accepts and gives back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AUTOMATION_STATES, AutomationInput, AutomationUpdate, LINK_TYPES as API_LINK_TYPES, TRIGGER_TYPES, VARIANT_LABELS as API_VARIANT_LABELS } from '../../../src/contracts/api/automations.js';
import { COMPLIANCE_LIMITS as L } from '../../../src/contracts/compliance.js';
import { warningsFor } from '../../../src/modules/automations/rules.js';
import {
  LIMITS, LINK_TYPES, STATES, STATE_ACTIONS, TRACKING, TRIGGERS, VARIANT_LABELS, addKeywords, addVariant, automationToForm, byteLength, bytesLabel, changeTrigger, draftWarnings, fillLocally,
  formToAutomation, inputToIso, isoToInput, launchChecks, newForm, publicReplyProblem, stateMoves, toggleMedia, triggerOf, triggersFor, unknownVariables,
} from '../../../console/src/features/automations/form.js';
import { MEASUREMENT_KINDS } from '../../../src/contracts/api/links.js';

const REEL = { id: '18001', type: 'reel', caption: 'The Diwali spice box', permalink: 'https://www.instagram.com/reel/abc/', thumbnailUrl: 'https://cdn.example/a.jpg', postedAt: null, automationId: null };
const POST = { ...REEL, id: '18002', type: 'post', caption: 'A post' };
const STORY = { ...REEL, id: '18003', type: 'story', caption: 'A story' };

/** A form a seller has finished, with the changes a test wants on top. */
function filled(changes = {}) {
  const base = newForm();
  return {
    ...base,
    name: 'Diwali box',
    keywords: ['SPICE'],
    media: [{ id: REEL.id, type: 'reel', channel: 'instagram', caption: REEL.caption, permalink: REEL.permalink, thumbnailUrl: REEL.thumbnailUrl }],
    variants: [{ ...base.variants[0], body: 'Hi {first_name}, here it is.' }],
    linkUrl: 'https://shop.example/p/1',
    ...changes,
  };
}

/** What the API returns for a saved automation, shaped like the contract's Automation. */
function savedAutomation(changes = {}) {
  return {
    id: 7, name: 'Diwali box', slug: 'diwali-box', state: 'draft', triggerType: 'comment', matchMode: 'keywords', keywords: ['SPICE'], includeReactions: false, priority: 0,
    linkMode: 'two_tap', linkType: 'seller_site', linkUrl: 'https://shop.example/p/1', finalUrl: 'https://shop.example/p/1?utm_source=instagram', linkStatus: 'ok', tapButtonTitle: 'Send me the link', linkButtonTitle: 'Open the link',
    publicReplyEnabled: false, followupEnabled: false, followupDelayMinutes: 60, followupText: '', linkMessage: 'Here it is', schedule: { startsAt: null, endsAt: null, dailyStart: null, dailyEnd: null, outsideHours: 'hold' }, dryRun: false,
    triggers: [{ id: 99, channel: 'instagram', targetType: 'reel', mediaId: REEL.id, permalink: REEL.permalink, thumbnailUrl: REEL.thumbnailUrl, caption: REEL.caption }],
    variants: [{ id: 5, label: 'A', body: 'Hi', buttonTitle: '', fallbackText: '', weight: 1, quickReplies: [] }],
    winnerVariantId: null, warnings: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...changes,
  };
}

test('the builder\'s limits and lists are the server\'s', () => {
  assert.deepEqual(
    { textBytes: LIMITS.textBytes, buttonTitleChars: LIMITS.buttonTitleChars, keywordsMax: LIMITS.keywordsMax, variantsMax: LIMITS.variantsMax, publicReplyMinVariants: LIMITS.publicReplyMinVariants, followupMinMinutes: LIMITS.followupMinMinutes },
    { textBytes: L.textBytes, buttonTitleChars: L.buttonTitleChars, keywordsMax: L.keywordsMax, variantsMax: L.variantsMax, publicReplyMinVariants: L.publicReplyMinVariants, followupMinMinutes: L.followupMinDelayMs / 60_000 },
  );
  assert.equal(LIMITS.followupMaxMinutes, AutomationInput.shape.followupDelayMinutes.unwrap().maxValue);
  assert.deepEqual(Object.keys(STATES).sort(), [...AUTOMATION_STATES].sort());
  assert.deepEqual(TRIGGERS.map((t) => t.value).sort(), [...TRIGGER_TYPES].sort());
  assert.deepEqual(LINK_TYPES.map((t) => t.value).sort(), [...API_LINK_TYPES].sort());
  assert.deepEqual([...VARIANT_LABELS], [...API_VARIANT_LABELS]);
  for (const { kind } of Object.values(TRACKING)) assert.ok(MEASUREMENT_KINDS.includes(kind), kind);
});

test('A-45: an empty form reports everything it is missing at once, including the keyword', () => {
  const { errors, body } = formToAutomation(newForm());
  assert.equal(body, undefined);
  assert.equal(errors.keywords, 'Add at least one keyword');
  assert.equal(errors.name, 'Give this automation a name');
  assert.equal(errors.variants, 'Write the message');
});

test('a keyword still in the box when saving counts', () => {
  const { body, errors } = formToAutomation(filled({ keywords: [], keywordDraft: 'link, shop' }));
  assert.equal(errors, undefined);
  assert.deepEqual(body.keywords, ['link', 'shop']);
});

test('keywords are chips: repeats are dropped whatever their case', () => {
  assert.deepEqual(addKeywords(['LINK'], 'link, Shop ,, shop'), ['LINK', 'Shop']);
});

test('more keywords than the limit are refused', () => {
  const keywords = Array.from({ length: L.keywordsMax + 1 }, (_, i) => `word${i}`);
  assert.match(formToAutomation(filled({ keywords })).errors.keywords, /20 keywords or fewer/);
});

test('A-44: keyword, message and link, with no products, is a complete automation the API accepts', () => {
  const { body, errors } = formToAutomation(filled());
  assert.equal(errors, undefined);
  const parsed = AutomationInput.parse(body);
  assert.deepEqual(parsed.triggers, [{ channel: 'instagram', targetType: 'reel', mediaId: REEL.id, permalink: REEL.permalink, thumbnailUrl: REEL.thumbnailUrl, caption: REEL.caption }]);
  assert.equal(parsed.linkMode, 'two_tap');
  assert.equal(parsed.publicReplyEnabled, false, 'public replies are off by default');
});

test('what a saved automation loads as, saved again, changes nothing', () => {
  const saved = savedAutomation({
    schedule: { startsAt: '2026-11-20T03:30:00.000Z', endsAt: '2026-11-22T03:30:00.000Z', dailyStart: '09:00', dailyEnd: '21:00', outsideHours: 'skip' },
    variants: [{ id: 5, label: 'A', body: 'Hi {first_name}', buttonTitle: 'Tap', fallbackText: 'Hi: {url}', weight: 2, quickReplies: [{ title: 'Yes', payload: 'y' }] }],
  });
  const { body, errors } = formToAutomation(automationToForm(saved));
  assert.equal(errors, undefined);
  AutomationUpdate.parse(body);
  assert.equal(body.triggers[0].mediaId, REEL.id, 'the trigger row\'s own id is not the media id');
  assert.deepEqual(body.variants, [{ label: 'A', body: 'Hi {first_name}', buttonTitle: 'Tap', fallbackText: 'Hi: {url}', weight: 2, quickReplies: [{ title: 'Yes', payload: 'y' }] }]);
  assert.equal(new Date(body.schedule.startsAt).getTime(), new Date(saved.schedule.startsAt).getTime());
  assert.equal(body.schedule.dailyStart, '09:00');
  assert.equal(body.schedule.outsideHours, 'skip');
  assert.equal(body.linkMessage, 'Here it is');
});

test('any-comment mode, once confirmed and saved, stays confirmed when edited', () => {
  const { errors } = formToAutomation(automationToForm(savedAutomation({ matchMode: 'any', keywords: [] })));
  assert.equal(errors, undefined);
});

test('C-34: 400 Devanagari letters are 1,200 bytes, shown as such and refused', () => {
  const body = 'भ'.repeat(400);
  assert.equal(byteLength(body), 1200);
  assert.equal(bytesLabel(body), '1,200 / 1,000 bytes');
  const base = filled();
  assert.match(formToAutomation({ ...base, variants: [{ ...base.variants[0], body }] }).errors.variants, /1,000 bytes/);
});

test('exactly the limit is allowed', () => {
  const base = filled();
  assert.equal(formToAutomation({ ...base, variants: [{ ...base.variants[0], body: 'a'.repeat(L.textBytes) }] }).errors, undefined);
});

test('A-27: a variable that does not exist is refused, naming the one that was typed', () => {
  assert.deepEqual(unknownVariables('Hi {username}, {first_name} and {url}'), ['{username}']);
  const base = filled();
  assert.match(formToAutomation({ ...base, variants: [{ ...base.variants[0], body: 'Hi {username}' }] }).errors.variants, /\{username\}/);
});

test('the variant at fault is named when there are several', () => {
  const base = filled();
  const variants = [{ ...base.variants[0], label: 'A', body: 'fine' }, { ...base.variants[0], label: 'B', body: '   ' }];
  assert.equal(formToAutomation({ ...base, variants }).errors.variants, 'Variant B: Write the message');
});

test('button text is measured in characters, against the limit', () => {
  const tooLong = 'x'.repeat(L.buttonTitleChars + 1);
  assert.match(formToAutomation(filled({ tapButtonTitle: tooLong })).errors.tapButtonTitle, /20 characters/);
  assert.match(formToAutomation(filled({ linkMode: 'one_tap', linkButtonTitle: tooLong })).errors.linkButtonTitle, /20 characters/);
  assert.equal(formToAutomation(filled({ linkMode: 'one_tap', tapButtonTitle: tooLong })).errors, undefined, 'the first button is not used with one tap');
  assert.equal(formToAutomation(filled({ linkButtonTitle: 'भ'.repeat(L.buttonTitleChars) })).errors, undefined, 'characters, not bytes');
});

test('A-46, C-31: public replies need 5 in the brand kit; someone who can\'t read the kit leaves it to the server', () => {
  const on = filled({ publicReplyEnabled: true });
  assert.equal(formToAutomation(on, { replyCount: 4 }).errors.publicReplyEnabled, 'Add at least 5 replies');
  assert.equal(formToAutomation(on, { replyCount: 5 }).errors, undefined);
  assert.equal(formToAutomation(on, { replyCount: null }).errors, undefined);
  assert.equal(publicReplyProblem(filled(), 0), '', 'off needs nothing');
});

test('public replies are only for comments', () => {
  const { body } = formToAutomation(filled({ triggerType: 'dm_keyword', publicReplyEnabled: true, media: [] }), { replyCount: 0 });
  assert.equal(body.publicReplyEnabled, false);
});

test('replying to every comment has to be confirmed; other triggers don\'t ask', () => {
  assert.ok(formToAutomation(filled({ matchMode: 'any' })).errors.anyModeAcknowledged);
  const confirmed = formToAutomation(filled({ matchMode: 'any', anyModeAcknowledged: true }));
  assert.equal(confirmed.errors, undefined);
  assert.deepEqual(confirmed.body.keywords, [], 'keywords mean nothing in this mode');
  assert.equal(formToAutomation(filled({ matchMode: 'any', triggerType: 'story_reply' })).errors, undefined);
});

test('story replies don\'t need a keyword; a story can be "any"', () => {
  const form = filled({ triggerType: 'story_reply', keywords: [], anyStory: true, media: [] });
  const { body, errors } = formToAutomation(form);
  assert.equal(errors, undefined);
  assert.deepEqual(body.triggers, [{ channel: 'instagram', targetType: 'any_story' }]);
  AutomationInput.parse(body);
});

test('mentions and welcome messages match everything and have no post', () => {
  for (const triggerType of ['story_mention', 'dm_welcome']) {
    const { body, errors } = formToAutomation(filled({ triggerType, keywords: ['leftover'], media: [] }));
    assert.equal(errors, undefined);
    assert.equal(body.matchMode, 'any');
    assert.deepEqual(body.keywords, []);
    assert.deepEqual(body.triggers, []);
    AutomationInput.parse(body);
  }
});

test('a keyword DM needs its keyword and no post', () => {
  assert.equal(formToAutomation(filled({ triggerType: 'dm_keyword', keywords: [], media: [] })).errors.keywords, 'Add at least one keyword');
  assert.deepEqual(triggersFor(filled({ triggerType: 'dm_keyword', media: [] })), []);
});

test('A-43: picking from the grid sets the trigger; a story and a reel can\'t be mixed', () => {
  const start = { ...newForm() };
  const first = toggleMedia(start, REEL);
  assert.equal(first.triggerType, 'comment');
  assert.deepEqual(first.media.map((m) => m.id), [REEL.id]);
  assert.equal(first.name, REEL.caption.slice(0, 60), 'the caption names it until the seller does');

  const second = toggleMedia({ ...start, ...first }, POST);
  assert.deepEqual(second.media.map((m) => m.id), [REEL.id, POST.id]);
  assert.equal(second.name, first.name, 'a name is not replaced');

  const story = toggleMedia({ ...start, ...second }, STORY);
  assert.equal(story.triggerType, 'story_reply');
  assert.deepEqual(story.media.map((m) => m.id), [STORY.id], 'a different kind starts again');

  const back = toggleMedia({ ...start, ...first }, REEL);
  assert.deepEqual(back.media, [], 'tapping again takes it off');
});

test('changing the trigger drops the picks that can\'t start it', () => {
  const media = toggleMedia(newForm(), REEL).media;
  assert.deepEqual(changeTrigger({ ...newForm(), media }, 'story_reply').media, []);
  assert.deepEqual(changeTrigger({ ...newForm(), media }, 'comment').media.map((m) => m.id), [REEL.id]);
  assert.deepEqual(changeTrigger({ ...newForm(), media }, 'dm_keyword').media, []);
});

test('three variants at most, each with its own letter', () => {
  let variants = newForm().variants;
  variants = addVariant(variants);
  variants = addVariant(variants);
  assert.deepEqual(variants.map((v) => v.label), ['A', 'B', 'C']);
  assert.equal(addVariant(variants), variants, 'nothing is added past the limit');
  assert.deepEqual(addVariant(variants.filter((v) => v.label !== 'B')).map((v) => v.label), ['A', 'C', 'B'], 'a freed letter is reused');
});

test('the schedule is India time, whatever the browser\'s clock says', () => {
  assert.equal(inputToIso('2026-11-20T09:00'), '2026-11-20T09:00:00+05:30');
  assert.equal(inputToIso(''), null);
  assert.equal(new Date(inputToIso('2026-11-20T09:00')).toISOString(), '2026-11-20T03:30:00.000Z');
  assert.equal(isoToInput('2026-11-20T03:30:00.000Z'), '2026-11-20T09:00');
  assert.equal(isoToInput('2026-11-20T18:30:00.000Z'), '2026-11-21T00:00', 'midnight is 00, not 24');
  assert.equal(isoToInput(null), '');
});

test('schedule mistakes are caught before saving', () => {
  assert.match(formToAutomation(filled({ startsAt: '2026-11-20T09:00', endsAt: '2026-11-20T09:00' })).errors.schedule, /after the start/);
  assert.match(formToAutomation(filled({ dailyStart: '09:00' })).errors.schedule, /both/);
  assert.match(formToAutomation(filled({ dailyStart: '09:00', dailyEnd: '09:00' })).errors.schedule, /same/);
  assert.equal(formToAutomation(filled({ dailyStart: '21:00', dailyEnd: '09:00' })).errors, undefined, 'hours may cross midnight');
});

test('a follow-up needs its words and a delay inside the rules', () => {
  assert.ok(formToAutomation(filled({ followupEnabled: true })).errors.followupText);
  for (const followupDelayMinutes of ['29', '1431', 'soon', '30.5']) {
    assert.ok(formToAutomation(filled({ followupEnabled: true, followupText: 'Still keen?', followupDelayMinutes })).errors.followupDelayMinutes, followupDelayMinutes);
  }
  assert.equal(formToAutomation(filled({ followupEnabled: true, followupText: 'Still keen?', followupDelayMinutes: '30' })).errors, undefined);
});

test('PRD 6.8: the warnings as the owner types are the ones the server gives after saving', () => {
  const form = filled({ matchMode: 'any', anyModeAcknowledged: true, keywords: [] });
  const live = draftWarnings(form);
  const server = warningsFor(savedAutomation({ matchMode: 'any', keywords: [] }));
  for (const code of ['any_mode', 'single_variant']) assert.equal(live.find((w) => w.code === code).message, server.find((w) => w.code === code).message, code);

  const short = draftWarnings(filled({ keywords: ['hi'] })).find((w) => w.code === 'short_keyword');
  assert.equal(short.message, warningsFor(savedAutomation({ keywords: ['hi'] })).find((w) => w.code === 'short_keyword').message);
  assert.equal(draftWarnings(filled({ keywords: ['🔥'] })).some((w) => w.code === 'short_keyword'), false, 'an emoji is not a short word');
});

test('an untouched form warns about nothing', () => {
  assert.deepEqual(draftWarnings(newForm()), []);
});

test('the launch list follows the trigger', () => {
  const labels = (form) => launchChecks(form).map((c) => c.label);
  assert.ok(labels(filled()).includes('Picked where it runs'));
  assert.ok(labels(filled()).includes('Keyword added'));
  assert.equal(labels(filled({ triggerType: 'dm_welcome', media: [] })).includes('Picked where it runs'), false);
  assert.equal(labels(filled({ triggerType: 'dm_welcome', media: [] })).includes('Link added'), false);
  assert.ok(launchChecks(filled()).every((c) => c.ok));
  assert.equal(launchChecks(filled({ linkUrl: '' })).find((c) => c.label === 'Link added').ok, false);
  assert.equal(launchChecks(filled({ publicReplyEnabled: true }), { replyCount: 2 }).find((c) => c.label === 'Enough public replies').ok, false);
});

test('every state move the builder offers is one the server allows', () => {
  const source = fs.readFileSync(new URL('../../../src/modules/automations/repo.js', import.meta.url), 'utf8');
  const allowed = new Function(`return ${/const TRANSITIONS = Object\.freeze\((\{[\s\S]*?\})\);/.exec(source)[1]}`)();
  for (const state of AUTOMATION_STATES) {
    for (const next of stateMoves(state)) {
      assert.ok(allowed[state].includes(next), `${state} to ${next}`);
      assert.ok(STATE_ACTIONS[next], `a button for ${next}`);
    }
  }
});

test('A-28: the preview never shows a variable\'s name, and reads correctly without the first name', () => {
  assert.equal(fillLocally('Hi {first_name}, your link: {url}', { url: 'https://x.example' }), 'Hi Asha, your link: https://x.example');
  assert.equal(fillLocally('Hi {first_name}, your link.', { firstName: '' }), 'Hi, your link.');
});

test('A-74: nothing the form starts with carries Bhava\'s name', () => {
  assert.doesNotMatch(JSON.stringify(newForm()), /bhava/i);
  assert.equal(triggerOf('nonsense').value, 'comment', 'an unknown trigger reads as the default rather than crashing the page');
});
