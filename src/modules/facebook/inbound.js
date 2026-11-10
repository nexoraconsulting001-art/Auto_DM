import { createAutomationEngine } from '../automations/engine.js';

/**
 * Answers a comment on a Facebook post that the owner linked to its Instagram twin (PRD 6.10): "one automation then covers both". The compliance
 * worker has already applied its rules, and everything else, keywords, schedule, the message, the caps and the send, is the automation engine's, with
 * the channel left as facebook so the job, the caps and the link's tag are Facebook's.
 *
 * Which automation is settled here: the link in force when the comment arrived (FB-03). A post with an automation of its own, or with no link, is
 * left to the automations module, which has already seen this event.
 */
export async function answerLinkedComment(event, ctx) {
  if (event.channel !== 'facebook' || event.type !== 'comment' || !event.mediaId || !ctx.config.facebookPages) return false;
  const { automations } = ctx.repos;
  if (await automations.forMedia('facebook', event.mediaId)) return false;
  const twin = await ctx.repos.fbLinks.twinAt(event.mediaId, new Date(event.receivedAt));
  if (!twin) return false;
  const automation = await automations.forMedia('instagram', twin);
  if (automation?.triggerType !== 'comment') return false;
  const engine = createAutomationEngine({ ...ctx, repos: { ...ctx.repos, automations: { ...automations, forMedia: async () => automation } } });
  return engine.handle(event);
}
