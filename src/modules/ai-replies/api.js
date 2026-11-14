import { ADDON_FEATURES, AI_THRESHOLD } from '../../contracts/addons.js';
import { ApiError } from '../../contracts/api/errors.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/**
 * The seller API of AI replies (src/contracts/api/addons.js, aiReplyRoutes): the FAQ, the settings, the test question and
 * the log. Every query names this business; the fence is the second lock. No answer names a shopper.
 */
const FEATURE = ADDON_FEATURES.aiReplies;
/** A business's own FAQ, with room to spare: the provider is given the 50 that relate most to each question. */
export const FAQ_MAX = 200;

const encode = (id) => Buffer.from(String(id)).toString('base64url');
function decode(cursor) {
  if (!cursor) return null;
  const id = Number(Buffer.from(String(cursor), 'base64url').toString());
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError('validation_failed', 'That page link is not valid.', { fields: { cursor: 'Invalid cursor' } });
  return id;
}
const pageOf = (rows, limit, toItem) => ({ items: rows.slice(0, limit).map(toItem), nextCursor: rows.length > limit ? encode(rows[limit - 1].id) : null });

const faqItem = (r) => ({ id: Number(r.id), question: r.question, answer: r.answer, active: Boolean(r.active), updatedAt: new Date(r.updated_at) });
const logItem = (r) => ({
  id: Number(r.id),
  channel: r.channel,
  threadId: r.thread_id === null ? null : Number(r.thread_id),
  question: r.question,
  answer: r.answer,
  sourceIds: r.source_ids ?? [],
  score: r.score === null ? null : Number(r.score),
  model: r.model,
  outcome: r.outcome,
  reason: r.reason ?? '',
  at: new Date(r.created_at),
});

const needsFaq = (err) => /ai_settings_needs_faq/.test(`${err?.constraint ?? ''} ${err?.message ?? ''}`);

export function aiRepliesApi(ctx, serviceFor) {
  const { db } = ctx;
  const service = () => serviceFor(ctx);
  const faqCount = async () => Number((await db.query('SELECT count(*)::int AS n FROM faq_entries WHERE tenant_id = $1 AND active', [tenantId()]))[0].n);

  async function view() {
    const { enabled, threshold } = await service().settings();
    const count = await faqCount();
    return { enabled, threshold, configured: Boolean(ctx.providers?.ai?.configured), faqCount: count, canEnable: count > 0 };
  }

  const audit = (user, action, details) => ctx.repos?.audit?.record({ actor: user?.id ? `user:${user.id}` : 'system', action, target: 'ai_replies', details })
    ?.catch?.((err) => reportError(err, { msg: 'ai_replies.audit_failed' }));

  return {
    async 'faq.list'({ query }) {
      const after = decode(query.cursor) ?? 0;
      const rows = await db.query(
        'SELECT id, question, answer, active, updated_at FROM faq_entries WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3',
        [tenantId(), after, query.limit + 1],
      );
      return pageOf(rows, query.limit, faqItem);
    },

    async 'faq.create'({ body }) {
      const [{ n }] = await db.query('SELECT count(*)::int AS n FROM faq_entries WHERE tenant_id = $1', [tenantId()]);
      if (Number(n) >= FAQ_MAX) throw new ApiError('validation_failed', `A business can keep up to ${FAQ_MAX} questions.`, { fields: { question: `Remove a question first: the limit is ${FAQ_MAX}` } });
      const [row] = await db.query(
        'INSERT INTO faq_entries (tenant_id, question, answer, active) VALUES ($1, $2, $3, $4) RETURNING id, question, answer, active, updated_at',
        [tenantId(), body.question, body.answer, body.active ?? true],
      );
      return faqItem(row);
    },

    async 'faq.update'({ params, body }) {
      const [row] = await db.query(
        `UPDATE faq_entries SET question = COALESCE($3, question), answer = COALESCE($4, answer), active = COALESCE($5, active), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING id, question, answer, active, updated_at`,
        [tenantId(), Number(params.id), body.question ?? null, body.answer ?? null, body.active ?? null],
      );
      if (!row) throw new ApiError('not_found');
      return faqItem(row);
    },

    async 'faq.remove'({ params }) {
      const [row] = await db.query('DELETE FROM faq_entries WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), Number(params.id)]);
      if (!row) throw new ApiError('not_found');
      return null;
    },

    'aiReplies.settings': () => view(),

    /** Switching on needs the add-on and an active FAQ entry; switching off and the threshold never need anything. */
    async 'aiReplies.save'({ body, user }) {
      if (body.enabled === true) {
        if (!(await ctx.repos.entitlements.can(FEATURE))) throw new ApiError('plan.feature_off', 'This is an add-on that isn’t on your plan.', { reason: 'plan', feature: FEATURE });
        if (!(await faqCount())) throw new ApiError('validation_failed', 'Add at least one question and answer first.', { fields: { enabled: 'Add at least one question and answer first' } });
      }
      try {
        await db.query(
          `INSERT INTO ai_settings (tenant_id, enabled, threshold, updated_at) VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::numeric, $4::numeric), now())
           ON CONFLICT (tenant_id) DO UPDATE SET enabled = COALESCE($2::boolean, ai_settings.enabled), threshold = COALESCE($3::numeric, ai_settings.threshold), updated_at = now()`,
          [tenantId(), body.enabled ?? null, body.threshold ?? null, AI_THRESHOLD.default],
        );
      } catch (err) {
        if (needsFaq(err)) throw new ApiError('validation_failed', 'Add at least one question and answer first.', { fields: { enabled: 'Add at least one question and answer first' } });
        throw err;
      }
      await audit(user, 'ai_replies.settings', { enabled: body.enabled ?? null, threshold: body.threshold ?? null });
      return view();
    },

    'aiReplies.testQuestion': ({ body }) => service().testQuestion(body.question),

    async 'aiReplies.log'({ query }) {
      const before = decode(query.cursor);
      const rows = await db.query(
        `SELECT id, channel, thread_id, question, answer, source_ids, score, model, outcome, reason, created_at FROM ai_reply_log
         WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2) AND ($3::text IS NULL OR outcome = $3) ORDER BY id DESC LIMIT $4`,
        [tenantId(), before, query.outcome ?? null, query.limit + 1],
      );
      return pageOf(rows, query.limit, logItem);
    },
  };
}
