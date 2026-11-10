import { canSeeRevenue } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { servicesFor as trafficServices } from '../traffic/services.js';
import { currentBusiness, teamReaders } from './business.js';
import { addDays, clockOf, monthLabel, periodLabel, zonedMoment } from './clock.js';
import { fileStore, monthlyFileUrl, monthlyKey } from './files.js';
import { changeText, emailHtml, escapeHtml, formatCount, formatRupees, reportPdf, snippet } from './render.js';

/**
 * The weekly summary and the monthly performance report (7.9). Both are built from the cache and the rollups only: no call to Meta, so a business
 * whose token expired, or a Meta outage, still gets its report. A report for one period is made once: its report_runs row and every delivery are written
 * in one transaction, and the unique period index lets only one worker do it.
 */
const ROLLUP_PAGE = 10_000;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const sum = (rows, key) => (rows.some((r) => isNumber(r[key])) ? rows.reduce((total, r) => total + (isNumber(r[key]) ? r[key] : 0), 0) : null);
const zeroIfNone = (value) => (isNumber(value) ? value : 0);

const KIND = Object.freeze({ feed: 'Post', reel: 'Reel', carousel: 'Carousel', story: 'Story' });
const GUARD = Object.freeze({ normal: 'Normal', learning: 'Learning your usual reach', watch: 'Watching: Instagram asked us to slow down', tripped: 'Slowed down: reach dropped', permission_needed: 'Needs the insights permission' });
const GUARD_ORDER = ['tripped', 'permission_needed', 'watch', 'learning', 'normal'];
const BANDS = Object.freeze({ good: 'Good', watch: 'Watch', at_risk: 'At risk' });
const SOURCE_NAMES = Object.freeze({
  instagram_comment_dm: 'Instagram comment DMs', story_reply: 'Story replies', story_mention: 'Story mentions', dm_keyword: 'DM keywords', bio_link: 'Bio link',
  facebook_dm: 'Facebook DMs', facebook_comment: 'Facebook comments', facebook_post: 'Facebook posts', facebook_bio: 'Facebook bio', whatsapp: 'WhatsApp', direct: 'Direct', other_referrer: 'Other websites',
});
const sourceName = (code) => SOURCE_NAMES[code] ?? (code ? String(code).replace(/_/g, ' ') : 'Unknown');

export const WEEKLY = 'weekly';
export const MONTHLY = 'monthly';

export function createPeriodic(ctx, { preferences }) {
  const { db, repos, platform, config } = ctx;
  const now = () => clockOf(config)();
  const rollups = () => platform.analytics.rollups;
  const files = () => fileStore(platform);

  async function readAll(store, spec) {
    const rows = [];
    for (let offset = 0; ; offset += ROLLUP_PAGE) {
      const page = await rollups().read(store, { ...spec, limit: ROLLUP_PAGE, offset });
      rows.push(...page);
      if (page.length < ROLLUP_PAGE) return rows;
    }
  }

  /** The rollups a report reads are brought up to date first, as Explore does. A failure here leaves the stored figures, and the report still goes. */
  async function refresh(range) {
    try {
      const traffic = trafficServices(ctx).rollupService;
      await traffic.ensureTrafficDaily(range);
      await traffic.ensureFunnelDaily(range);
    } catch (err) {
      reportError(err, { msg: 'reports.refresh_failed', tenantId: tenantId() });
    }
  }

  // ---- figures ---------------------------------------------------------------------------------------------------------

  async function instagramIds() {
    const rows = await db.query(`SELECT account_id FROM analytics_accounts WHERE tenant_id = $1 AND channel = 'instagram'`, [tenantId()]);
    return rows.map((r) => r.account_id);
  }

  async function account(range, ids) {
    if (!ids.length) return { views: null, reach: null, followers: null };
    const rows = await readAll('meta_account_daily', { measures: ['views', 'reach', 'followers_count'], dimensions: ['day'], filters: [{ dimension: 'account_id', op: 'include', values: ids }], ...range, orderBy: 'day', direction: 'asc' });
    const withFollowers = rows.filter((r) => isNumber(r.followers_count));
    return { views: sum(rows, 'views'), reach: sum(rows, 'reach'), followers: withFollowers.length ? withFollowers.at(-1).followers_count : null };
  }

  async function funnel(range) {
    const [row] = await rollups().read('funnel_daily', { measures: ['comments', 'dms_sent', 'taps', 'visits', 'orders', 'revenue_paise'], ...range, limit: 1 });
    return { comments: zeroIfNone(row?.comments), dms: zeroIfNone(row?.dms_sent), taps: zeroIfNone(row?.taps), visits: zeroIfNone(row?.visits), orders: zeroIfNone(row?.orders), revenuePaise: zeroIfNone(row?.revenue_paise) };
  }

  /** The most-viewed posts and reels of the last four weeks. Stories, a day old at most, would never compare. */
  async function topMedia(since, timeZone) {
    const rows = await db.query(
      `SELECT media_id, kind, caption, latest FROM insight_media
       WHERE tenant_id = $1 AND kind <> 'story' AND deleted_at IS NULL AND COALESCE(posted_at, created_at) >= $2::timestamptz
       ORDER BY CASE WHEN jsonb_typeof(latest->'views') = 'number' THEN (latest->>'views')::numeric END DESC NULLS LAST,
                CASE WHEN jsonb_typeof(latest->'reach') = 'number' THEN (latest->>'reach')::numeric END DESC NULLS LAST, id DESC
       LIMIT 3`,
      [tenantId(), new Date(zonedMoment(since, 0, 0, timeZone))],
    );
    return rows.map((r) => ({ mediaId: r.media_id, kind: r.kind, caption: snippet(r.caption, 70), views: isNumber(r.latest?.views) ? r.latest.views : null }));
  }

  async function guardAndHealth() {
    const states = await db.query('SELECT state FROM reach_guard_state WHERE tenant_id = $1', [tenantId()]);
    const state = GUARD_ORDER.find((s) => states.some((r) => r.state === s)) ?? null;
    const [health] = await db.query('SELECT score, band FROM account_health WHERE tenant_id = $1 ORDER BY score, account_ref LIMIT 1', [tenantId()]);
    return { reachGuard: state, health: health ? { score: health.score, band: health.band } : null };
  }

  /** 'ok', 'reconnect' when a connected account needs signing in again (an expired or refused token), or 'none' when nothing is connected. */
  async function connection() {
    const rows = await db.query(`SELECT status, (token_expires_at IS NOT NULL AND token_expires_at < now()) AS expired FROM ig_accounts WHERE tenant_id = $1`, [tenantId()]);
    if (!rows.length) return 'none';
    return rows.some((r) => r.status !== 'active' || r.expired) ? 'reconnect' : 'ok';
  }

  function notices(state) {
    if (state === 'reconnect') return [{ title: 'Reconnect Instagram', text: 'Your Instagram connection has stopped working. Figures from Instagram stop updating until you reconnect it in Bhava.' }];
    if (state === 'none') return [{ title: 'Connect Instagram', text: 'Connect your Instagram account in Bhava to see views, reach and followers here.' }];
    return [];
  }

  // ---- delivering -----------------------------------------------------------------------------------------------------

  /**
   * Writes the run and its deliveries together. Returns null when another worker already made this period's run, so nothing is sent twice.
   * `messagesFor(runId)` gives the rows to write once the run's id is known.
   */
  async function record({ kind, periodStart, periodEnd, summary, storageKey = '' }, messagesFor) {
    return db.tx(async (t) => {
      const [run] = await t.query(
        `INSERT INTO report_runs (tenant_id, kind, period_start, period_end, status, storage_key, summary) VALUES ($1, $2, $3::date, $4::date, 'building', $5, $6::jsonb)
         ON CONFLICT DO NOTHING RETURNING id`,
        [tenantId(), kind, periodStart, periodEnd, storageKey, JSON.stringify(summary)],
      );
      if (!run) return null;
      const messages = await messagesFor(run.id, t);
      for (const m of messages) {
        await t.query(
          `INSERT INTO report_deliveries (tenant_id, report_run_id, channel, user_id, to_address, subject, body) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId(), run.id, m.channel, m.userId ?? null, m.to ?? '', m.subject, m.body],
        );
      }
      await t.query(`UPDATE report_runs SET status = $3, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END WHERE tenant_id = $1 AND id = $2`, [tenantId(), run.id, messages.length ? 'sent' : 'skipped']);
      return { id: run.id, deliveries: messages.length };
    });
  }

  const unsubscribeUrl = (business, token, report) => `${business.base}/reporting/unsubscribe?token=${encodeURIComponent(token)}&report=${report}`;
  const footer = (business, url, report) => `You get this as a member of the ${escapeHtml(business.name)} team on Bhava. <a href="${escapeHtml(url)}" style="color:#3B2FC9">Unsubscribe from ${report} reports</a>`;

  // ---- weekly (7.9) ---------------------------------------------------------------------------------------------------

  async function weeklySummary(business, { periodStart, periodEnd }) {
    const week = { since: periodStart, until: periodEnd };
    const before = { since: addDays(periodStart, -7), until: addDays(periodStart, -1) };
    await refresh({ since: before.since, until: periodEnd });
    const ids = await instagramIds();
    const sales = await repos.entitlements.can('funnel.sales');
    const [thisWeek, lastWeek] = [await account(week, ids), await account(before, ids)];
    const [funnelNow, funnelBefore] = [await funnel(week), await funnel(before)];
    const money = (f) => (sales ? f : { comments: f.comments, dms: f.dms, taps: f.taps, visits: f.visits });
    return {
      period: week, previous: before, hasRevenue: sales,
      account: { views: [thisWeek.views, lastWeek.views], reach: [thisWeek.reach, lastWeek.reach], followers: [thisWeek.followers, lastWeek.followers] },
      topMedia: await topMedia(addDays(periodStart, -21), business.timeZone),
      funnel: { now: money(funnelNow), before: money(funnelBefore) },
      ...(await guardAndHealth()),
      connection: await connection(),
    };
  }

  function weeklyEmail(business, summary, { showRevenue, unsubscribe }) {
    const { account: a, funnel: f } = summary;
    const sections = [];
    if (summary.connection === 'none') sections.push({ heading: 'Instagram this week', text: 'No Instagram account is connected.' });
    else {
      sections.push({ heading: 'Instagram this week', figures: [
        ['Views', formatCount(a.views[0]), changeText(a.views[0], a.views[1])],
        ['Reach', formatCount(a.reach[0]), changeText(a.reach[0], a.reach[1])],
        ['Followers', formatCount(a.followers[0]), changeText(a.followers[0], a.followers[1])],
      ] });
    }
    sections.push({ heading: 'Your top posts', table: { columns: ['Post', 'Views'], rows: summary.topMedia.map((m) => [`${KIND[m.kind] ?? 'Post'}: ${m.caption || m.mediaId}`, formatCount(m.views)]) }, empty: 'No posts in the last four weeks.' });
    const funnelFigures = [
      ['Comments', formatCount(f.now.comments), changeText(f.now.comments, f.before.comments)],
      ['DMs sent', formatCount(f.now.dms), changeText(f.now.dms, f.before.dms)],
      ['Taps or visits', formatCount(f.now.taps), changeText(f.now.taps, f.before.taps)],
    ];
    if (showRevenue) {
      funnelFigures.push(['Orders', formatCount(f.now.orders), changeText(f.now.orders, f.before.orders)]);
      funnelFigures.push(['Revenue', formatRupees(f.now.revenuePaise), changeText(f.now.revenuePaise, f.before.revenuePaise)]);
    }
    sections.push({ heading: 'Your Bhava funnel', figures: funnelFigures });
    sections.push({ heading: 'Reach Guard and Account Health', figures: [
      ['Reach Guard', summary.reachGuard ? GUARD[summary.reachGuard] : 'Not checked yet'],
      ['Account Health', summary.health ? `${summary.health.score} out of 100, ${BANDS[summary.health.band] ?? summary.health.band}` : 'Not scored yet'],
    ] });
    const label = periodLabel(summary.period.since, summary.period.until);
    return {
      subject: `Bhava weekly report for ${business.name}: ${label}`,
      body: emailHtml({
        businessName: business.name, logoUrl: business.logoUrl, title: `Your week, ${label}`, intro: 'Compared with the week before.',
        notices: notices(summary.connection), sections, links: [['Open your dashboard', `${business.base}/admin`]],
        footer: footer(business, unsubscribe, 'weekly'),
      }),
    };
  }

  async function runWeekly(due) {
    const business = await currentBusiness(ctx);
    if (!business?.reporting) return null;
    const summary = await weeklySummary(business, due);
    const people = await teamReaders(db);
    const prefs = await preferences.all();
    const wanted = people.filter((p) => prefs.get(p.id)?.weekly !== false);
    const result = await record({ kind: WEEKLY, periodStart: due.periodStart, periodEnd: due.periodEnd, summary }, async (_runId, t) => {
      const messages = [];
      for (const person of wanted) {
        const token = await preferences.issueToken(t, person.id);
        const email = weeklyEmail(business, summary, { showRevenue: summary.hasRevenue && canSeeRevenue(person), unsubscribe: unsubscribeUrl(business, token, 'weekly') });
        messages.push({ channel: 'email', userId: person.id, to: person.email, ...email });
        if (person.role === 'owner') messages.push({ channel: 'push', userId: person.id, subject: 'Your weekly report is ready', body: `Your Bhava weekly report for ${business.name} is ready.` });
      }
      return messages;
    });
    if (result) log.info('reports.weekly_sent', { tenantId: tenantId(), runId: result.id, deliveries: result.deliveries });
    return result;
  }

  // ---- monthly (7.9) --------------------------------------------------------------------------------------------------

  async function contentRows(range, sales) {
    const funnelRows = await readAll('funnel_daily', { measures: ['dms_sent', 'orders', 'revenue_paise'], dimensions: ['media_id', 'content_kind'], ...range, orderBy: 'dms_sent', direction: 'desc' });
    const trafficRows = await readAll('traffic_daily', { measures: ['landing_views', 'product_taps'], dimensions: ['media_id'], ...range, filters: [{ dimension: 'media_id', op: 'exclude', values: [''] }] });
    const byMedia = new Map();
    const entry = (id) => byMedia.get(id) ?? byMedia.set(id, { mediaId: id, kind: null, dms: 0, visits: 0, taps: 0, orders: 0, revenuePaise: 0 }).get(id);
    for (const r of funnelRows) {
      if (!r.media_id) continue;
      const e = entry(r.media_id);
      e.kind ??= r.content_kind || null;
      e.dms += zeroIfNone(r.dms_sent);
      e.orders += zeroIfNone(r.orders);
      e.revenuePaise += zeroIfNone(r.revenue_paise);
    }
    for (const r of trafficRows) {
      const e = entry(r.media_id);
      e.visits += zeroIfNone(r.landing_views);
      e.taps += zeroIfNone(r.product_taps);
    }
    const ids = [...byMedia.keys()];
    const known = ids.length ? await db.query('SELECT media_id, kind, caption FROM insight_media WHERE tenant_id = $1 AND media_id = ANY($2::text[])', [tenantId(), ids]) : [];
    for (const m of known) {
      const e = byMedia.get(m.media_id);
      e.kind = m.kind;
      e.caption = snippet(m.caption, 50);
    }
    return [...byMedia.values()].map((e) => (sales ? e : { mediaId: e.mediaId, kind: e.kind, caption: e.caption, dms: e.dms, visits: e.visits, taps: e.taps }))
      .sort((a, b) => b.dms - a.dms || b.visits - a.visits || (a.mediaId < b.mediaId ? -1 : 1));
  }

  async function trafficTotals(range, sales) {
    const [row] = await rollups().read('traffic_daily', { measures: ['sessions', 'landing_views', 'product_taps', 'orders', 'revenue_paise'], ...range, limit: 1 });
    const out = { sessions: zeroIfNone(row?.sessions), visits: zeroIfNone(row?.landing_views), taps: zeroIfNone(row?.product_taps) };
    return sales ? { ...out, orders: zeroIfNone(row?.orders), revenuePaise: zeroIfNone(row?.revenue_paise) } : out;
  }

  async function bySource(range, sales) {
    const rows = await readAll('traffic_daily', { measures: ['sessions', ...(sales ? ['orders', 'revenue_paise'] : [])], dimensions: ['source'], ...range, orderBy: 'sessions', direction: 'desc' });
    return rows.map((r) => ({ source: r.source, sessions: zeroIfNone(r.sessions), ...(sales ? { orders: zeroIfNone(r.orders), revenuePaise: zeroIfNone(r.revenue_paise) } : {}) }));
  }

  async function topPages(range) {
    const rows = await rollups().read('traffic_daily', { measures: ['sessions'], dimensions: ['landing_page'], filters: [{ dimension: 'landing_page', op: 'exclude', values: [''] }], ...range, orderBy: 'sessions', direction: 'desc', limit: 5 });
    return rows.map((r) => ({ page: r.landing_page, sessions: zeroIfNone(r.sessions) }));
  }

  async function topProducts(range) {
    const rows = await rollups().read('traffic_items_daily', { measures: ['views', 'taps'], dimensions: ['item_ref'], filters: [{ dimension: 'item_kind', op: 'include', values: ['product'] }, { dimension: 'item_ref', op: 'exclude', values: [''] }], ...range, orderBy: 'views', direction: 'desc', limit: 5 });
    const numeric = rows.map((r) => r.item_ref).filter((ref) => /^\d{1,9}$/.test(ref)).map(Number);
    const names = numeric.length ? await db.query('SELECT id, name FROM products WHERE tenant_id = $1 AND id = ANY($2::int[])', [tenantId(), numeric]) : [];
    const nameOf = new Map(names.map((p) => [String(p.id), p.name]));
    return rows.map((r) => ({ product: nameOf.get(r.item_ref) ?? r.item_ref, views: zeroIfNone(r.views), taps: zeroIfNone(r.taps) }));
  }

  async function monthlySummary({ periodStart, periodEnd }) {
    const month = { since: periodStart, until: periodEnd };
    const before = { since: addDays(periodStart, -1).slice(0, 7) + '-01', until: addDays(periodStart, -1) };
    await refresh({ since: before.since, until: periodEnd });
    const sales = await repos.entitlements.can('funnel.sales');
    const funnelNow = await funnel(month);
    const funnelBefore = await funnel(before);
    const pick = (f) => (sales ? { dms: f.dms, orders: f.orders, revenuePaise: f.revenuePaise } : { dms: f.dms });
    return {
      period: month, previous: before, hasRevenue: sales,
      totals: { now: { ...(await trafficTotals(month, sales)), ...pick(funnelNow) }, before: { ...(await trafficTotals(before, sales)), ...pick(funnelBefore) } },
      content: (await contentRows(month, sales)).slice(0, 200),
      sources: await bySource(month, sales),
      pages: await topPages(month),
      products: await topProducts(month),
      connection: await connection(),
    };
  }

  function monthlySections(summary, showRevenue) {
    const { now: n, before: b } = summary.totals;
    const totals = [
      ['DMs sent', formatCount(n.dms), changeText(n.dms, b.dms)],
      ['Sessions on your pages', formatCount(n.sessions), changeText(n.sessions, b.sessions)],
      ['Landing page visits', formatCount(n.visits), changeText(n.visits, b.visits)],
      ['Product taps', formatCount(n.taps), changeText(n.taps, b.taps)],
    ];
    if (showRevenue) {
      totals.push(['Orders', formatCount(n.orders), changeText(n.orders, b.orders)]);
      totals.push(['Revenue', formatRupees(n.revenuePaise), changeText(n.revenuePaise, b.revenuePaise)]);
    }
    const contentColumns = ['Reel, post or story', 'DMs sent', 'Landing page visits', 'Product taps', ...(showRevenue ? ['Orders', 'Revenue'] : [])];
    const contentRow = (c) => [`${KIND[c.kind] ?? 'Content'}: ${c.caption || c.mediaId}`, formatCount(c.dms), formatCount(c.visits), formatCount(c.taps), ...(showRevenue ? [formatCount(c.orders), formatRupees(c.revenuePaise)] : [])];
    return {
      totals: { heading: 'This month, compared with the month before', figures: totals },
      content: (limit) => ({ heading: 'Per reel, post and story', table: { columns: contentColumns, rows: summary.content.slice(0, limit).map(contentRow) }, empty: 'No DMs or visits from your content this month.' }),
      sources: { heading: 'Traffic by source', table: { columns: ['Source', 'Sessions', ...(showRevenue ? ['Orders', 'Revenue'] : [])], rows: summary.sources.map((s) => [sourceName(s.source), formatCount(s.sessions), ...(showRevenue ? [formatCount(s.orders), formatRupees(s.revenuePaise)] : [])]) }, empty: 'No visits to your pages this month.' },
      pages: { heading: 'Top landing pages', table: { columns: ['Page', 'Sessions'], rows: summary.pages.map((p) => [p.page, formatCount(p.sessions)]) }, empty: 'No visits to your pages this month.' },
      products: { heading: 'Top products', table: { columns: ['Product', 'Views', 'Taps'], rows: summary.products.map((p) => [p.product, formatCount(p.views), formatCount(p.taps)]) }, empty: 'No product views this month.' },
    };
  }

  async function runMonthly(due) {
    const business = await currentBusiness(ctx);
    if (!business?.reporting) return null;
    if (!(await repos.entitlements.can('report.monthly'))) return null;
    const summary = await monthlySummary(due);
    const title = `Your ${monthLabel(due.periodStart)} performance report`;
    const pdfSections = monthlySections(summary, summary.hasRevenue);
    const pdf = await reportPdf({ businessName: business.name, title, intro: 'Compared with the month before.', sections: [pdfSections.totals, pdfSections.content(200), pdfSections.sources, pdfSections.pages, pdfSections.products] });
    const key = monthlyKey(due.periodStart);
    await files().put(key, pdf, 'application/pdf');

    const people = await teamReaders(db);
    const prefs = await preferences.all();
    const wanted = people.filter((p) => prefs.get(p.id)?.monthly !== false);
    const result = await record({ kind: MONTHLY, periodStart: due.periodStart, periodEnd: due.periodEnd, summary, storageKey: key }, async (runId, t) => {
      const messages = [];
      for (const person of wanted) {
        const token = await preferences.issueToken(t, person.id);
        const showRevenue = summary.hasRevenue && canSeeRevenue(person);
        const s = monthlySections(summary, showRevenue);
        const links = [['Open the full report', `${business.base}${monthlyFileUrl(runId)}`]].filter(() => !summary.hasRevenue || showRevenue);
        messages.push({
          channel: 'email', userId: person.id, to: person.email,
          subject: `Bhava monthly report for ${business.name}: ${monthLabel(due.periodStart)}`,
          body: emailHtml({
            businessName: business.name, logoUrl: business.logoUrl, title, intro: 'Compared with the month before. The full report is kept in your Bhava admin.',
            notices: notices(summary.connection), sections: [s.totals, s.content(25), s.sources, s.pages, s.products],
            links: [...links, ['Open your dashboard', `${business.base}/admin`]], footer: footer(business, unsubscribeUrl(business, token, 'monthly'), 'monthly'),
          }),
        });
      }
      return messages;
    });
    if (result) log.info('reports.monthly_sent', { tenantId: tenantId(), runId: result.id, deliveries: result.deliveries });
    return result;
  }

  return { runWeekly, runMonthly, now };
}
