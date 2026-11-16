// atk-auth-2: a NUL byte in an input string is refused by the contract (400) before any query runs, because Postgres text
// cannot hold one and would answer 500. `text()` always refused it; schemas built straight from z.string() whose own pattern
// lets \0 through (\S, [^\s@]) did not. Each of those now ends with the shared `noNul`, and each is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaLink, noNul, text } from '../../../src/contracts/api/common.js';
import { PlatformTeamAdd, SignInStart, SignInVerify } from '../../../src/contracts/api/platform-ops.js';
import { WhatsappKeywordSetInput } from '../../../src/contracts/api/addons.js';
import { AppConfigUpdate } from '../../../src/contracts/api/apps.js';
import { AppMinimumSet, SubmissionMove } from '../../../src/contracts/api/platform.js';
import { z } from 'zod';

const NUL = '\u0000';
const refused = (schema, value, label) => {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, `${label}: a NUL byte was accepted`);
};
const accepted = (schema, value, label) => {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, true, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`);
};

test('atk-auth-2: the Platform Console email refuses NUL on sign-in, verify and team add, and still takes a real address', () => {
  for (const email of [`a${NUL}@b.c`, `a@b${NUL}.c`, `a@b.c${NUL}`]) {
    refused(SignInStart, { email }, 'SignInStart');
    refused(SignInVerify, { email, code: '123456' }, 'SignInVerify');
    refused(PlatformTeamAdd, { email, role: 'support' }, 'PlatformTeamAdd');
  }
  accepted(SignInStart, { email: ' Ops@Example.COM ' }, 'SignInStart');
  assert.equal(SignInStart.parse({ email: ' Ops@Example.COM ' }).email, 'ops@example.com');
  accepted(SignInVerify, { email: 'ops@example.com', code: '123456' }, 'SignInVerify');
});

test('atk-auth-2: every other link schema whose pattern let NUL through now refuses it', () => {
  refused(MediaLink, `https://cdn.example.com/a${NUL}.png`, 'MediaLink');
  accepted(MediaLink, 'https://cdn.example.com/a.png', 'MediaLink');
  accepted(MediaLink, '/media/abc-123', 'MediaLink');

  const keywords = { keywords: ['hi'], reelId: null, message: 'Hello' };
  refused(WhatsappKeywordSetInput, { ...keywords, linkUrl: `https://shop.example.com/${NUL}` }, 'WhatsappKeywordSetInput.linkUrl');
  accepted(WhatsappKeywordSetInput, { ...keywords, linkUrl: 'https://shop.example.com/p' }, 'WhatsappKeywordSetInput.linkUrl');

  refused(AppConfigUpdate, { privacyUrl: `https://brand.example.com/privacy${NUL}` }, 'AppConfigUpdate.privacyUrl');
  accepted(AppConfigUpdate, { privacyUrl: 'https://brand.example.com/privacy' }, 'AppConfigUpdate.privacyUrl');

  refused(AppMinimumSet, { platform: 'android', minVersion: '1.2.0', storeUrl: `https://play.google.com/store/apps/details?id=a.b${NUL}` }, 'AppMinimumSet.storeUrl');
  accepted(AppMinimumSet, { platform: 'android', minVersion: '1.2.0', storeUrl: 'https://play.google.com/store/apps/details?id=a.b' }, 'AppMinimumSet.storeUrl');

  refused(SubmissionMove, { to: 'live', reason: 'went live', storeUrl: `https://apps.apple.com/app/x${NUL}` }, 'SubmissionMove.storeUrl');
  refused(SubmissionMove, { to: 'rejected', reason: 'store said no', rejection: { guideline: '4.2.6', message: `bad${NUL}` } }, 'SubmissionMove.rejection.message');
  accepted(SubmissionMove, { to: 'rejected', reason: 'store said no', rejection: { guideline: '4.2.6', message: 'Too thin' } }, 'SubmissionMove.rejection.message');
});

test('atk-auth-2: the shared guard is what text() uses, so the rule lives in one place', () => {
  refused(text(10), `a${NUL}`, 'text');
  refused(noNul(z.string()), `a${NUL}`, 'noNul');
  accepted(noNul(z.string()), 'a', 'noNul');
});
