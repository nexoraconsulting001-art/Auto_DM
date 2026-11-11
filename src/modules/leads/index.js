import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { leadsApi } from './api.js';
import { leadFormFor } from './form.js';
import { dropFile, registerLeadPages } from './pages.js';
import { leadsRepo } from './repo.js';

/**
 * PRD 8.15: the lead form on landing pages, the creator page and the store, consent per channel against a numbered wording,
 * withdrawal, deletion and downloads (migration 306). A hidden field and a limit per address (in the cache, never stored)
 * stop spam; no CAPTCHA. Leads are personal data: nothing here logs a name, phone number or email, and every query is one
 * business's. New-lead alerts go to repos.alerts.
 *
 * Other buyer pages place the form with leadFormFor(ctx, req, { theme, surface, pageSlug, pageOverride, back }) from here:
 * it answers the form's section, or '' when the business shows none there. `repos.leads` is the data.
 */
export { leadFormFor, leadFormState } from './form.js';

export const QUEUE_SWEEP = 'leads.sweep_files';
const SWEEP_EVERY_MS = 3_600_000;

/** Removes the files of downloads past their time, business by business. */
export async function sweepFiles(ctx) {
  const { db, repos, platform } = ctx;
  const due = await db.platform.query(`SELECT tenant_id, id, file_key FROM lead_downloads WHERE status = 'ready' AND expires_at <= now() ORDER BY id LIMIT 500`);
  let removed = 0;
  for (const row of due) {
    try {
      await withTenant(row.tenant_id, () => dropFile({ repos, platform }, row));
      removed++;
    } catch (err) {
      reportError(err, { msg: 'leads.sweep_failed', downloadId: row.id });
    }
  }
  if (removed) log.info('leads.files_swept', { removed });
  return removed;
}

export const leads = {
  name: 'leads',
  repos: (db) => ({ leads: leadsRepo(db) }),
  api: (ctx) => leadsApi(ctx),
  routes: (app, ctx) => registerLeadPages(app, ctx),
  /** The form as the landing page's lead_form block: the pages module asks for it by this name. The page's own switch wins. */
  buyerBlocks: {
    lead_form: ({ surface, page, theme, req }, ctx) => leadFormFor(ctx, req, {
      theme,
      surface,
      pageSlug: page?.slug ?? '',
      pageOverride: page?.lead_form ?? null,
      back: page?.slug ? `/r/${page.slug}` : '',
    }),
  },
  jobs(ctx) {
    ctx.platform.queue.work(QUEUE_SWEEP, () => sweepFiles(ctx));
    return async () => {
      await ctx.platform.queue.every(QUEUE_SWEEP, SWEEP_EVERY_MS);
    };
  },
};
