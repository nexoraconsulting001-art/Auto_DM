// What the compliance tests share: a clock they control, a business with a connected account, and a Meta stand-in they can script.
import { MetaApiError, classifyGraphError } from '../../../src/adapters/meta/index.js';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const START = Date.parse('2026-11-01T10:00:00.000Z');

let shared = null;
let counter = 0;

/** One error as Meta would give it. */
export function metaError({ status = 400, code, subcode, usage = null, kind, delivery = 'none' }) {
  return new MetaApiError({ method: 'POST', pathname: 'x/messages', status, code, subcode, usage, kind: kind ?? classifyGraphError({ status, code, subcode }), delivery, detail: 'scripted' });
}

/** Stands in for createInstagram(). `script` is shifted once per send call; an Error is thrown, anything else is the receipt. */
export function scriptedIg(script = []) {
  const calls = [];
  let n = 0;
  const handle = (kind) => async (account, ...args) => {
    calls.push({ kind, token: account.token, account, args });
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return { messageId: `m_${++n}_${process.hrtime.bigint()}`, status: 200, usage: null };
  };
  return {
    calls,
    script,
    sendPrivateReply: handle('text'),
    sendPrivateReplyButton: handle('button'),
    sendMessage: handle('message'),
    replyToComment: handle('reply'),
  };
}

/**
 * A business with an Instagram account, on a database shared by the file unless `fresh` is set. Every rule that reads a clock reads
 * clock.t, and random is fixed, so a test can stand exactly on an edge.
 */
export async function world({ fresh = false, base: given = null, ig = scriptedIg(), limits = {}, config = {}, at = START, random = 0.5 } = {}) {
  const base = given ?? (fresh ? await setup() : (shared ??= await setup()));
  const n = ++counter;
  // A worker turn looks across businesses, so what an earlier test left waiting must not be sent with this test's stand-ins.
  if (!fresh && !given) {
    await base.db.platform.query(`UPDATE outbound_jobs SET status = 'cancelled' WHERE status IN ('queued', 'held', 'sending')`);
    await base.db.platform.query(`UPDATE inbound_events SET status = 'done' WHERE status IN ('stored', 'processing')`);
  }
  const tenant = await base.platform.tenants.create({ slug: `shop-${process.pid}-${n}`, name: `Shop ${n}` });
  const igUserId = `IG-${process.pid}-${n}`;
  await base.platform.tenants.linkIgAccount(tenant.id, igUserId, `shop${n}`);
  const clock = { t: at, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  const inBusiness = (fn) => withTenant(tenant, fn);
  await inBusiness(() => base.platform.igAccounts.setToken(igUserId, 'token-1'));
  const compliance = createCompliance({
    db: base.db,
    repos: base.platform,
    ig,
    config: { complianceNow: clock.now, complianceRandom: () => random, complianceLimits: limits, complianceInline: false, ...config },
    platform: { metrics: { inc() {} } },
  });
  const inTenant = (sql, params) => inBusiness(() => base.db.query(sql, params));
  const hash = (person, channel = 'instagram') => inBusiness(() => base.platform.compliance.subjectHash(channel, person));
  return {
    ...base,
    tenant,
    igUserId,
    ig,
    clock,
    compliance,
    inBusiness,
    inTenant,
    hash,
    /** A person last messaged the business at ms (now by default): the 24-hour window runs from there. */
    async messaged(person, ms = clock.t) {
      const subject = await hash(person);
      await inTenant(
        `INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, subject_hash, recipient_id, last_user_message_at) VALUES ($1, 'instagram', $2, $3, $4, $5::timestamptz)
         ON CONFLICT (tenant_id, channel, subject_hash) DO UPDATE SET last_user_message_at = EXCLUDED.last_user_message_at`,
        [tenant.id, igUserId, subject, person, new Date(ms)],
      );
    },
    /** One worker turn with the clock where it is. */
    async turn() {
      compliance.invalidateSwitches();
      return compliance.pump();
    },
    /** Lets everything ready go, without moving the clock. */
    async settle() {
      compliance.invalidateSwitches();
      await compliance.release();
      let total = 0;
      for (let i = 0; i < 2000; i++) {
        const sent = await compliance.drainOutbound();
        if (!sent) break;
        total += sent;
      }
      return total;
    },
    events: () => inTenant('SELECT * FROM compliance_events WHERE tenant_id = $1 ORDER BY id', [tenant.id]),
    jobs: () => inTenant('SELECT * FROM outbound_jobs WHERE tenant_id = $1 ORDER BY id', [tenant.id]),
    reasons: async () => (await inTenant('SELECT reason FROM compliance_events WHERE tenant_id = $1 ORDER BY id', [tenant.id])).map((r) => r.reason),
    needsHuman: () => inTenant('SELECT * FROM needs_human_items WHERE tenant_id = $1 ORDER BY id', [tenant.id]),
    alerts: () => inTenant('SELECT * FROM alerts WHERE tenant_id = $1 ORDER BY id', [tenant.id]),
    /** The breaker as it stands now. */
    breakerState: async () => (await inTenant(`SELECT * FROM breakers WHERE tenant_id = $1 AND channel = 'instagram'`, [tenant.id]))[0] ?? { state: 'closed' },
    /** Runs fn on every send, with the clock as it was. */
    onSend(fn) {
      for (const name of ['sendPrivateReply', 'sendPrivateReplyButton', 'sendMessage', 'replyToComment']) {
        const real = ig[name];
        ig[name] = (...args) => {
          fn(clock.t, name);
          return real(...args);
        };
      }
    },
    /** The body of a webhook delivery for this account. */
    delivery: (...changes) => ({ object: 'instagram', entry: [{ id: igUserId, time: Math.floor(clock.t / 1000), changes }] }),
  };
}

let seq = 0;
export const uid = (prefix = 'id') => `${prefix}-${++seq}`;

export const comment = (fields = {}) => ({
  field: 'comments',
  value: {
    id: fields.id ?? uid('c'),
    text: fields.text ?? 'LINK',
    from: { id: fields.from ?? 'person', username: 'asha' },
    media: { id: fields.media ?? 'M1', media_product_type: fields.type ?? 'REELS' },
    ...(fields.parent ? { parent_id: fields.parent } : {}),
    ...(fields.verb ? { verb: fields.verb } : {}),
  },
});

/** A DM from a person, as a webhook body. */
export const inMessage = (w, { from = 'person', text = 'hi', mid = uid('m'), at = w.clock.t, ...more } = {}) => ({
  object: 'instagram',
  entry: [{ id: w.igUserId, time: at, messaging: [{ sender: { id: from }, recipient: { id: w.igUserId }, timestamp: at, message: { mid, text, ...more } }] }],
});

/** An automation row, as the automations track would have made it. */
export async function automation(w, { keywords = ['link'], state = 'live', matchMode = 'keywords', publicReply = false, dryRun = false, media = '' } = {}) {
  const [row] = await w.inTenant(
    `INSERT INTO automations (tenant_id, name, slug, state, trigger_type, keywords, match_mode, public_reply_enabled, dry_run) VALUES ($1, 'A', $2, $3, 'comment', $4::text[], $5, $6, $7) RETURNING id`,
    [w.tenant.id, uid('auto').toLowerCase(), state, keywords, matchMode, publicReply, dryRun],
  );
  if (media) {
    await w.inTenant(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', $3)`, [w.tenant.id, row.id, media]);
  }
  return row.id;
}

/** One action, as a module would ask for it. */
export const dm = (w, fields = {}) => ({ kind: 'dm', accountId: w.igUserId, recipientId: 'person', personId: 'person', idempotencyKey: uid('dm'), expiresAt: new Date(w.clock.t + HOUR), message: { text: 'hello' }, ...fields });

export const privateReply = (w, fields = {}) => {
  const commentId = fields.commentId ?? uid('c');
  return { kind: 'private_reply', accountId: w.igUserId, commentId, personId: 'person', idempotencyKey: `private_reply:${commentId}`, expiresAt: new Date(w.clock.t + 6 * DAY), message: { text: 'hello' }, ...fields };
};
