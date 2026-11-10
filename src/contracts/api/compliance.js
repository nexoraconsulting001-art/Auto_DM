import { z } from 'zod';
import { Channel, OUTCOMES, REASON_CODES, REASON_CODE_FAMILIES } from '../compliance.js';
import { MANAGERS, staffWith } from './access.js';
import { Count, Id, IdParams, IdText, ListQuery, Timestamp, page, required, text } from './common.js';

const reader = staffWith('automations');
const inboxReader = staffWith('inbox');

export const ReasonCode = z.union([z.enum(REASON_CODES), z.literal('')]);
export const WORD_LISTS = Object.freeze(['optout', 'negative', 'handoff']);

export const ComplianceGate = z.object({ code: z.enum(REASON_CODE_FAMILIES.gate), passed: z.boolean() });

/** What is stopping this business's sends right now, for the console's status banner. canResume is false for a pause by support. */
export const ComplianceStatus = z.object({
  paused: z.boolean(),
  pausedBy: z.enum(['owner', 'ops', 'billing']).nullable(),
  canResume: z.boolean(),
  pauseStore: z.boolean(),
  globalPause: z.boolean(),
  reconnectNeeded: z.boolean(),
  breaker: z.enum(['closed', 'open', 'half_open']),
  slowMode: z.object({ active: z.boolean(), until: Timestamp.nullable(), canOverride: z.boolean() }),
  heldJobs: Count,
  gates: z.array(ComplianceGate),
});

export const PauseBody = z.object({ pauseStore: z.boolean().default(false) });

/** capOverrides may only lower a cap (PRD 4.7); the handler refuses anything higher. */
export const ComplianceSettings = z.object({
  dryRun: z.boolean(),
  disclosureEnabled: z.boolean(),
  utmEnabled: z.boolean(),
  capOverrides: z.partialRecord(z.enum(REASON_CODE_FAMILIES.cap), z.number().int().min(0)),
});
export const ComplianceSettingsUpdate = ComplianceSettings.partial();

/** The activity view's rows. No person's id, hashed or otherwise. */
export const ComplianceActivity = z.object({
  id: z.number().int().positive(),
  at: Timestamp,
  channel: Channel,
  kind: z.string(),
  outcome: z.string(),
  reason: ReasonCode,
  automationId: Id.nullable(),
  mediaId: z.string(),
  commentId: z.string(),
});
export const ComplianceActivityQuery = ListQuery.extend({
  reason: z.enum(REASON_CODES).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  automationId: IdText.optional(),
  mediaId: text(80).optional(),
});

export const WhyNoDmQuery = z.object({ commentId: required(80) });
export const WhyNoDm = z.object({ commentId: z.string(), outcome: z.string(), reason: ReasonCode, explanation: z.string(), at: Timestamp });

export const HeldJob = z.object({ id: z.number().int().positive(), kind: z.string(), automationId: Id.nullable(), reason: ReasonCode, heldAt: Timestamp, expiresAt: Timestamp });
export const DiscardHeld = z.object({ automationId: Id.optional() });
export const Discarded = z.object({ discarded: Count });

/** Only when the trigger was a reach drop, and only with the words typed out (PRD 4.3). */
export const SlowModeOverride = z.object({ confirmation: required(40) });

export const WordListQuery = z.object({ list: z.enum(WORD_LISTS) });
export const TenantWord = z.object({ id: Id, list: z.enum(WORD_LISTS), word: z.string() });
export const WordLists = z.object({ base: z.array(z.string()), added: z.array(TenantWord) });
export const WordAdd = z.object({ list: z.enum(WORD_LISTS), word: required(60) });

export const complianceRoutes = {
  'compliance.status': { method: 'GET', path: '/compliance/status', access: reader, response: ComplianceStatus },
  'compliance.pause': { method: 'POST', path: '/compliance/pause', access: MANAGERS, body: PauseBody, response: ComplianceStatus },
  'compliance.resume': { method: 'POST', path: '/compliance/resume', access: MANAGERS, response: ComplianceStatus },
  'compliance.settings': { method: 'GET', path: '/compliance/settings', access: reader, response: ComplianceSettings },
  'compliance.updateSettings': { method: 'PATCH', path: '/compliance/settings', access: MANAGERS, body: ComplianceSettingsUpdate, response: ComplianceSettings },
  'compliance.activity': { method: 'GET', path: '/compliance/activity', access: reader, query: ComplianceActivityQuery, response: page(ComplianceActivity) },
  'compliance.whyNoDm': { method: 'GET', path: '/compliance/why-no-dm', access: inboxReader, query: WhyNoDmQuery, response: WhyNoDm },
  'compliance.heldJobs': { method: 'GET', path: '/compliance/held-jobs', access: reader, query: ListQuery, response: page(HeldJob) },
  'compliance.discardHeld': { method: 'POST', path: '/compliance/held-jobs/discard', access: MANAGERS, body: DiscardHeld, response: Discarded },
  'compliance.slowModeOverride': { method: 'POST', path: '/compliance/slow-mode/override', access: MANAGERS, body: SlowModeOverride, response: ComplianceStatus },
  'compliance.words': { method: 'GET', path: '/compliance/words', access: reader, query: WordListQuery, response: WordLists },
  'compliance.addWord': { method: 'POST', path: '/compliance/words', access: MANAGERS, body: WordAdd, status: 201, response: TenantWord },
  'compliance.removeWord': { method: 'DELETE', path: '/compliance/words/:id', access: MANAGERS, params: IdParams, status: 204, response: null },
};
