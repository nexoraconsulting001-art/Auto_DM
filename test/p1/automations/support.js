import { AutomationInput } from '../../../src/contracts/api/automations.js';
import { COMPLIANCE_LIMITS as L, ComplianceAction } from '../../../src/contracts/compliance.js';
import { automations, createAutomationEngine } from '../../../src/modules/automations/index.js';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

export const ACCOUNT = 'IG-SHOP';
export const REEL = 'REEL-1';
export const STORY = 'STORY-1';
export const PERSON = 'P-100';
export const LINK = 'https://seller.test/product/1';
const OWNER_ACTOR = 'user:1';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

let counter = 0;
const next = () => ++counter;

/** Stands in for Meta's reads. */
export const fakeMeta = ({ people = {} } = {}) => ({
  client: { forAccount: () => ({ getPerson: async (id) => people[id] ?? {} }) },
});

/**
 * Stands in for the compliance engine, so these tests are about what the automations ask for: an action that fits the contract
 * and the options that go with it. It writes the job row as enqueue does, and reports a key it has seen as a duplicate.
 */
export function fakeCompliance(db, tenantId, repos) {
  const enqueued = [];
  const sent = [];
  return {
    enqueued,
    sent,
    async enqueue(input, options = {}) {
      const action = ComplianceAction.parse(input);
      const instagram = action.channel === 'instagram';
      const subject = await repos.compliance.subjectHash(action.channel, action.personId);
      const [row] = await db.platform.query(
        `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, fb_page_id, kind, purpose, idempotency_key, automation_id, variant_id, media_id, comment_id, recipient_id, subject_hash, payload, expires_at, run_at, is_test)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
        [tenantId, action.channel, instagram ? action.accountId : null, instagram ? null : action.accountId, action.kind, action.purpose, action.idempotencyKey, action.automationId ?? null, action.variantId ?? null,
          action.mediaId ?? '', action.commentId ?? '', action.recipientId ?? '', subject, JSON.stringify({ message: action.message }), action.expiresAt, options.runAt ?? new Date(), action.isTest],
      );
      if (!row) return { outcome: 'skipped', reason: 'webhook.duplicate', jobId: null };
      enqueued.push({ action, options });
      return { outcome: 'queued', reason: '', jobId: Number(row.id) };
    },
    async send(input) {
      const action = ComplianceAction.parse(input);
      sent.push(action);
      return { outcome: 'sent', reason: '', jobId: null, messageId: `m-${sent.length}` };
    },
    async check() {
      return { allow: true, outcome: 'queued', reason: '' };
    },
  };
}

/** One business with a connected account on `plan`, a clock the test moves, and events shaped as the compliance worker delivers them. */
export async function world({ plan = 't3', meta = fakeMeta() } = {}) {
  const base = await setup();
  return attach({ ...base, plan, meta });
}

async function attach({ db, platform, tenant: first, plan, meta, slug, account = ACCOUNT }) {
  const tenant = slug ? await platform.tenants.create({ slug, name: slug }) : first;
  const repos = bindTenant(platform, tenant);
  await platform.tenants.linkIgAccount(tenant.id, account, 'shop');
  await repos.igAccounts.setToken(account, 'token');
  await db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenant.id]);

  const clock = { at: Date.now() };
  const compliance = fakeCompliance(db, tenant.id, platform);
  const engine = createAutomationEngine({ db, repos: platform, compliance, meta, now: () => clock.at });
  const inBusiness = (fn) => withTenant(tenant, fn);
  const subjectOf = (personId) => inBusiness(() => platform.compliance.subjectHash('instagram', personId));

  /** The thread the compliance worker would have upserted for a message from this person. */
  async function thread(personId, { lastUserAt = new Date(clock.at), username = 'asha' } = {}) {
    const subject = await subjectOf(personId);
    const [row] = await db.platform.query(
      `INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, subject_hash, recipient_id, username, last_message, last_message_at, last_user_message_at)
       VALUES ($1, 'instagram', $2, $3, $4, $5, 'hello', $6, $6)
       ON CONFLICT (tenant_id, channel, subject_hash) DO UPDATE SET last_user_message_at = EXCLUDED.last_user_message_at RETURNING *`,
      [tenant.id, account, subject, personId, username, lastUserAt],
    );
    return row;
  }

  const person = async ({ from = PERSON, at = clock.at, ...rest }) => ({ channel: 'instagram', accountId: account, personId: from, subject: await subjectOf(from), timestamp: at, receivedAt: new Date(clock.at), ...rest });
  const handed = async (partial, opens = true) => {
    const event = await person(partial);
    const row = opens ? await thread(event.personId, { lastUserAt: new Date(event.timestamp) }) : null;
    return { ...event, threadId: row?.id ?? partial.threadId, threadPaused: partial.threadPaused ?? '', mid: partial.mid ?? `m${next()}`, text: partial.text ?? '' };
  };

  const events = {
    comment: async ({ id = `c${next()}`, mediaId = REEL, text = 'price', type = 'REELS', username = 'asha', expiresAt, ...rest } = {}) => ({
      ...await person(rest), type: 'comment', commentId: id, mediaId, mediaType: type, username, text, expiresAt: expiresAt ?? new Date(clock.at + L.privateReplyExpiryMs),
    }),
    dm: async ({ text = 'hi', quickReply = '', ...rest } = {}) => ({ ...await handed({ text, ...rest }), type: 'dm', quickReply }),
    storyReply: async ({ text = 'link', storyId = STORY, ...rest } = {}) => ({ ...await handed({ text, ...rest }), type: 'story_reply', storyId, mediaId: storyId, mediaRef: 'https://media.test/story.jpg' }),
    mention: async ({ threadId, ...rest } = {}) => ({ ...await handed({ text: '', threadId, ...rest }, false), type: 'story_mention', mediaRef: 'https://media.test/mention.jpg' }),
    postback: async ({ payload, title = 'Tap', ...rest } = {}) => ({ ...await handed({ text: title, ...rest }), type: 'postback', payload }),
  };

  const handle = (event) => inBusiness(() => automations.onInboundEvent(event, { db, repos: platform, compliance, meta, config: { complianceNow: () => clock.at } }));
  const direct = (event) => inBusiness(() => engine.handle(event));

  const jobs = (where = 'TRUE') => db.platform.query(`SELECT * FROM outbound_jobs WHERE tenant_id = $1 AND ${where} ORDER BY id`, [tenant.id]);
  const log = () => db.platform.query('SELECT * FROM compliance_events WHERE tenant_id = $1 ORDER BY id', [tenant.id]);
  const lastReason = async () => (await log()).at(-1)?.reason;

  const create = async (input, state = 'live') => {
    const saved = await repos.automations.create(AutomationInput.parse({
      name: `Automation ${next()}`, triggerType: 'comment', keywords: ['price'], linkUrl: LINK, triggers: [{ targetType: 'reel', mediaId: REEL }], variants: [{ label: 'A', body: 'Here it is' }], ...input,
    }), { actor: OWNER_ACTOR });
    return state === 'draft' ? saved : repos.automations.setState(saved.id, state, { actor: OWNER_ACTOR });
  };

  const addTester = async (personId = PERSON) => {
    const { code } = await repos.testers.createCode({ actor: OWNER_ACTOR, label: 'phone', now: new Date(clock.at) });
    return direct(await events.dm({ from: personId, text: code }));
  };

  return { db, platform, tenant, repos, meta, clock, compliance, engine, inBusiness, events, handle: direct, viaModule: handle, jobs, log, lastReason, create, addTester, thread, subjectOf };
}

/** A second business in the same database as `w`. */
export const another = (w, slug, account = 'IG-OTHER') => attach({ db: w.db, platform: w.platform, tenant: w.tenant, plan: 't3', meta: fakeMeta(), slug, account });

export const closeWorld = (w) => w.db.close();

/** Runs a test body with its own business and closes the database after. */
export const inWorld = (options, body) => async () => {
  const [opts, run] = body ? [options, body] : [{}, options];
  const w = await world(opts);
  try {
    await run(w);
  } finally {
    await closeWorld(w);
  }
};
