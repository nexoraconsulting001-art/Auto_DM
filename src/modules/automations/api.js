import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { COMPLIANCE_LIMITS as L } from '../../contracts/compliance.js';
import { checkContent } from '../compliance/content.js';
import { directLink } from '../links/rules.js';
import { engineFor } from './engine.js';
import { windowOpen } from './inbox.js';
import { faqPayload, render } from './message.js';
import { checkLaunch, checkSave, contentProblems, normalizeTriggers, warningsFor } from './rules.js';

const SAMPLE_NAME = 'Asha';
const actorOf = (user) => `user:${user.id}`;

/** Answers the automations, testers, ice breaker and inbox routes of the seller API (PRD 6.1 to 6.9). */
export function automationsApi(ctx) {
  const { repos, compliance, meta, config } = ctx;
  const deps = { repos, config };
  const clock = () => new Date((config.complianceNow ?? Date.now)());

  async function present(automation) {
    if (!automation) return null;
    const settings = await repos.automations.sendSettings();
    const finalUrl = automation.linkUrl
      ? directLink({ url: automation.linkUrl, linkType: automation.linkType, channel: automation.triggers[0]?.channel ?? 'instagram', automationSlug: automation.slug, mediaId: automation.triggers[0]?.mediaId ?? '', variantLabel: automation.variants[0]?.label ?? '', utmEnabled: settings.utm, measurement: {} })
      : '';
    return { ...automation, finalUrl, warnings: warningsFor(automation) };
  }

  /** The body with a trigger's fields in the shape they are stored in. */
  const stored = (body, triggerType) => (body.triggers ? { ...body, triggers: normalizeTriggers(triggerType, body.triggers) } : body);

  async function pushIceBreakers(items) {
    const account = await repos.igAccounts.current();
    if (!account?.token) return;
    try {
      const api = meta.client.forAccount(account);
      if (!items.length) await api.clearIceBreakers();
      else await api.setIceBreakers([{ locale: 'default', call_to_actions: items.map((item, index) => ({ question: item.question, payload: faqPayload(index + 1) })) }]);
    } catch (err) {
      if (err.kind === 'token_invalid') throw new ApiError('conflict', 'Reconnect Instagram to update your questions.', { reason: 'paused.reconnect' });
      throw new ApiError('conflict', 'Instagram didn’t accept those questions. They are saved here, so try again in a moment.');
    }
  }

  return {
    'automations.list': ({ query }) => repos.automations.list(query),

    async 'automations.create'({ body, user }) {
      await checkSave(stored(body, body.triggerType), deps);
      const limit = await repos.entitlements.limit('automations');
      return present(await repos.automations.create(stored(body, body.triggerType), { createdBy: user.id, limit, actor: actorOf(user) }));
    },

    async 'automations.get'({ params }) {
      return present(await repos.automations.get(params.id));
    },

    async 'automations.update'({ params, body, user }) {
      const current = await repos.automations.get(params.id);
      if (!current) return null;
      if (current.state === 'archived') throw new ApiError('conflict', 'An archived automation can’t be changed. Move it back to draft first.');
      const triggerType = body.triggerType ?? current.triggerType;
      const change = stored(body, triggerType);
      const after = { ...current, ...change };
      if (['test', 'live'].includes(current.state)) await checkLaunch(after, deps);
      else await checkSave(after, deps);
      return present(await repos.automations.update(params.id, change, { actor: actorOf(user) }));
    },

    async 'automations.remove'({ params, user }) {
      if (!(await repos.automations.remove(params.id, { actor: actorOf(user) }))) throw new ApiError('not_found');
    },

    async 'automations.setState'({ params, body, user }) {
      const current = await repos.automations.get(params.id);
      if (!current) return null;
      if (['test', 'live'].includes(body.state)) {
        await checkLaunch(current, deps);
        // The link check before going live (PRD 4.11) belongs to the links module. A module refuses by throwing an ApiError.
        for (const module of ctx.modules ?? []) await module.beforeAutomationLaunch?.(current, ctx);
      }
      return present(await repos.automations.setState(params.id, body.state, { actor: actorOf(user) }));
    },

    async 'automations.pickWinner'({ params, body, user }) {
      return present(await repos.automations.pickWinner(params.id, body.variantId, { actor: actorOf(user) }));
    },

    async 'automations.stats'({ params }) {
      const automation = await repos.automations.get(params.id);
      return automation ? repos.automations.stats(automation) : null;
    },

    async 'automations.sendTest'({ params, body }) {
      const automation = await repos.automations.get(params.id);
      if (!automation) return null;
      const tester = await repos.testers.get(body.testerId);
      if (!tester) throw new ApiError('not_found', 'That tester isn’t on this business.');
      const result = await engineFor(ctx).sendTest(automation, tester, body.variantLabel);
      if (!result) throw new ApiError('validation_failed', 'That version doesn’t exist.', { fields: { variantLabel: 'Pick one of this automation’s versions' } });
      return { outcome: result.outcome, reason: result.reason };
    },

    /** Checks a message as the owner types: filled in, and again with {first_name} empty (PRD 6.5). */
    'automations.preview'({ body }) {
      const filled = render(body.body, { firstName: SAMPLE_NAME, url: body.linkUrl });
      const problems = contentProblems({ template: body.body, text: filled, buttonTitle: body.buttonTitle || undefined, filled: true });
      return {
        filled,
        withoutName: render(body.body, { firstName: '', url: body.linkUrl }),
        bytes: Buffer.byteLength(filled),
        maxBytes: L.textBytes,
        problems: problems.map(({ reason, message }) => ({ reason, message })),
      };
    },

    'testers.list': ({ query }) => repos.testers.list({ ...query, now: clock() }),

    'testers.createCode': ({ body, user }) => repos.testers.createCode({ createdBy: user.id, label: body.label, actor: actorOf(user), now: clock() }),

    async 'testers.remove'({ params, user }) {
      if (!(await repos.testers.remove(params.id, { actor: actorOf(user) }))) throw new ApiError('not_found');
    },

    'iceBreakers.get': () => repos.iceBreakers.get(),

    async 'iceBreakers.save'({ body, user }) {
      for (const [index, item] of body.items.entries()) {
        const [problem] = [...checkContent({ text: item.question }), ...contentProblems({ template: item.templateBody })];
        if (problem) throw new ApiError('validation_failed', problem.message, { fields: { [`items.${index}`]: problem.message }, reason: problem.reason });
      }
      await repos.iceBreakers.save(body.items, { actor: actorOf(user) });
      await pushIceBreakers(body.items);
      return repos.iceBreakers.get();
    },

    'inbox.threads': ({ query }) => repos.inbox.listThreads({ ...query, now: clock() }),

    'inbox.thread': ({ params }) => repos.inbox.threadDetail(params.id, clock()),

    /**
     * A reply the owner types (PRD 6.7): only inside the window, through the gate like every other send, and it pauses
     * automation in the thread for 12h. An opt-out blocks automation, so a manual reply is still allowed.
     */
    async 'inbox.reply'({ params, body }) {
      const thread = await repos.inbox.threadRow(params.id);
      if (!thread) return null;
      if (!windowOpen(thread.last_user_message_at, clock())) throw new ApiError('conflict', 'Reply in the Instagram app', { reason: 'window.closed' });
      const accountId = thread.ig_user_id ?? thread.fb_page_id;
      const result = await compliance.send({
        kind: 'dm', purpose: 'manual', channel: thread.channel, accountId, recipientId: thread.recipient_id, personId: thread.recipient_id, idempotencyKey: `manual:${thread.id}:${crypto.randomUUID()}`,
        expiresAt: new Date(new Date(thread.last_user_message_at).getTime() + L.messagingWindowMs), message: { text: body.text },
      });
      if (!['sent', 'sent_fallback'].includes(result.outcome)) return { outcome: result.outcome, reason: result.reason, automationPausedUntil: repos.inbox.toThread(thread, clock()).automationPausedUntil };
      await repos.inbox.addOwnerReply({ threadId: thread.id, text: body.text, mid: result.messageId, at: clock() });
      const automationPausedUntil = await repos.inbox.pauseForOwner(thread.id, new Date(clock().getTime() + L.threadOwnerRepliedMs));
      return { outcome: result.outcome, reason: result.reason, automationPausedUntil };
    },

    'inbox.needsHuman': ({ query }) => repos.inbox.listNeedsHuman(query),

    'inbox.resolve': ({ params, user }) => repos.inbox.resolve(params.id, user.id),
  };
}
