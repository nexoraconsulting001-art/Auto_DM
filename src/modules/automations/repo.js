import { ApiError } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { slugify } from '../../util.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';

/** Columns set from the same-named field of the API input. */
const COLUMNS = Object.freeze({
  name: 'name', triggerType: 'trigger_type', matchMode: 'match_mode', keywords: 'keywords', includeReactions: 'include_reactions', priority: 'priority',
  linkMode: 'link_mode', linkType: 'link_type', linkUrl: 'link_url', tapButtonTitle: 'tap_button_title', linkButtonTitle: 'link_button_title',
  publicReplyEnabled: 'public_reply_enabled', followupEnabled: 'followup_enabled', followupDelayMinutes: 'followup_delay_minutes', dryRun: 'dry_run',
});

const TRANSITIONS = Object.freeze({
  draft: ['test', 'live', 'archived'],
  test: ['draft', 'live', 'paused', 'archived'],
  live: ['test', 'paused', 'archived'],
  paused: ['draft', 'test', 'live', 'archived'],
  archived: ['draft'],
});

// Any fixed number: it only has to differ from the other advisory locks taken on a business.
const CREATE_LOCK = 4_242_102;

const SENT = `('sent', 'sent_fallback')`;

/** The database refused a second automation on the same media. */
function friendly(err) {
  if (err?.code === '23505' && /automation_triggers_(media|any_story)_idx/.test(`${err.constraint ?? ''} ${err.message ?? ''}`)) {
    return new ApiError('conflict', 'Another automation already uses that reel, post or story. Archive it first.');
  }
  return err;
}

const hhmm = (time) => (time ? String(time).slice(0, 5) : null);

function columnsFrom(input) {
  const values = {};
  for (const [field, column] of Object.entries(COLUMNS)) if (input[field] !== undefined) values[column] = input[field];
  if (input.schedule) {
    Object.assign(values, {
      starts_at: input.schedule.startsAt, ends_at: input.schedule.endsAt, daily_start: input.schedule.dailyStart, daily_end: input.schedule.dailyEnd, outside_hours: input.schedule.outsideHours,
    });
  }
  return values;
}

/** Automations and what hangs off them: triggers and message versions (PRD 6.5, 6.8). Every call is for the current business. */
export function automationsRepo(db) {
  async function hydrate(runner, rows) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const triggers = await runner.query('SELECT * FROM automation_triggers WHERE tenant_id = $1 AND automation_id = ANY($2::int[]) ORDER BY id', [tenantId(), ids]);
    const texts = await runner.query(
      `SELECT m.automation_id, m.role, v.* FROM message_templates m
       JOIN template_variants v ON v.tenant_id = m.tenant_id AND v.template_id = m.id
       WHERE m.tenant_id = $1 AND m.automation_id = ANY($2::int[]) AND v.active ORDER BY v.label`,
      [tenantId(), ids],
    );
    return rows.map((row) => {
      const own = texts.filter((v) => v.automation_id === row.id);
      const bodyOf = (role) => own.find((v) => v.role === role)?.body ?? '';
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        state: row.state,
        pausedReason: row.paused_reason,
        triggerType: row.trigger_type,
        matchMode: row.match_mode,
        anyModeAcknowledged: Boolean(row.any_mode_acknowledged),
        keywords: row.keywords ?? [],
        includeReactions: row.include_reactions,
        priority: row.priority,
        linkMode: row.link_mode,
        linkType: row.link_type,
        linkUrl: row.link_url,
        linkStatus: row.link_status,
        tapButtonTitle: row.tap_button_title,
        linkButtonTitle: row.link_button_title,
        publicReplyEnabled: row.public_reply_enabled,
        followupEnabled: row.followup_enabled,
        followupDelayMinutes: row.followup_delay_minutes,
        followupText: bodyOf('followup'),
        linkMessage: bodyOf('link_dm'),
        schedule: { startsAt: row.starts_at, endsAt: row.ends_at, dailyStart: hhmm(row.daily_start), dailyEnd: hhmm(row.daily_end), outsideHours: row.outside_hours },
        dryRun: row.dry_run,
        triggers: triggers.filter((t) => t.automation_id === row.id).map((t) => ({
          id: t.id, channel: t.channel, targetType: t.target_type, mediaId: t.media_id, permalink: t.permalink, thumbnailUrl: t.thumbnail_url, caption: t.caption,
        })),
        variants: own.filter((v) => v.role === 'first_dm').map((v) => ({
          id: v.id, label: v.label, body: v.body, buttonTitle: v.button_title, fallbackText: v.fallback_text, weight: v.weight, quickReplies: v.quick_replies ?? [],
        })),
        winnerVariantId: row.winner_variant_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async function load(runner, id) {
    const [row] = await runner.query('SELECT * FROM automations WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
    return row ? (await hydrate(runner, [row]))[0] : null;
  }

  async function templateId(t, automationId, role) {
    const [row] = await t.query(
      `INSERT INTO message_templates (tenant_id, automation_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, automation_id, role) WHERE automation_id IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id`,
      [tenantId(), automationId, role],
    );
    return row.id;
  }

  async function saveVariant(t, template, { label, body, buttonTitle = '', fallbackText = '', weight = 1, quickReplies = [] }) {
    await t.query(
      `INSERT INTO template_variants (tenant_id, template_id, label, body, button_title, fallback_text, weight, quick_replies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, template_id, label) DO UPDATE SET body = EXCLUDED.body, button_title = EXCLUDED.button_title, fallback_text = EXCLUDED.fallback_text,
         weight = EXCLUDED.weight, quick_replies = EXCLUDED.quick_replies, active = true, updated_at = now()`,
      [tenantId(), template, label, body, buttonTitle, fallbackText, weight, JSON.stringify(quickReplies)],
    );
  }

  /** A single-version message such as the follow-up. Empty text removes it. */
  async function saveSingle(t, automationId, role, body) {
    if (!body) {
      await t.query('DELETE FROM message_templates WHERE tenant_id = $1 AND automation_id = $2 AND role = $3', [tenantId(), automationId, role]);
      return;
    }
    await saveVariant(t, await templateId(t, automationId, role), { label: 'A', body });
  }

  /** Versions keep their row when they are removed, so their sends stay on the books. */
  async function saveVariants(t, automationId, variants) {
    const template = await templateId(t, automationId, 'first_dm');
    for (const variant of variants) await saveVariant(t, template, variant);
    const retired = await t.query(
      `UPDATE template_variants SET active = false, updated_at = now() WHERE tenant_id = $1 AND template_id = $2 AND active AND NOT (label = ANY($3::text[])) RETURNING id`,
      [tenantId(), template, variants.map((v) => v.label)],
    );
    if (retired.length) {
      await t.query('UPDATE automations SET winner_variant_id = NULL WHERE tenant_id = $1 AND id = $2 AND winner_variant_id = ANY($3::int[])', [tenantId(), automationId, retired.map((v) => v.id)]);
    }
  }

  async function saveTriggers(t, automationId, triggers, active) {
    await t.query('DELETE FROM automation_triggers WHERE tenant_id = $1 AND automation_id = $2', [tenantId(), automationId]);
    for (const trigger of triggers) {
      await t.query(
        `INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id, permalink, thumbnail_url, caption, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tenantId(), automationId, trigger.channel, trigger.targetType, trigger.mediaId, trigger.permalink, trigger.thumbnailUrl, trigger.caption, active],
      );
    }
  }

  async function saveChildren(t, automationId, input, { triggersActive = true } = {}) {
    if (input.triggers) await saveTriggers(t, automationId, input.triggers, triggersActive);
    if (input.variants) await saveVariants(t, automationId, input.variants);
    if (input.linkMessage !== undefined) await saveSingle(t, automationId, 'link_dm', input.linkMessage);
    if (input.followupText !== undefined) await saveSingle(t, automationId, 'followup', input.followupText);
  }

  /** A slug that is free in this business, for utm_campaign. The caller holds CREATE_LOCK. */
  async function freeSlug(t, name) {
    const base = slugify(name).replace(/-+$/, '') || 'automation';
    const taken = new Set((await t.query('SELECT slug FROM automations WHERE tenant_id = $1 AND (slug = $2 OR slug LIKE $3)', [tenantId(), base, `${base}-%`])).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  return {
    /** `limit` is the plan's number of automations, counted under a lock so that two saves can't both take the last one. */
    async create(input, { createdBy = null, limit = Infinity, actor }) {
      try {
        const id = await db.tx(async (t) => {
          await t.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [CREATE_LOCK, tenantId()]);
          const [{ n }] = await t.query(`SELECT count(*)::int AS n FROM automations WHERE tenant_id = $1 AND state <> 'archived'`, [tenantId()]);
          if (n >= limit) throw new ApiError('validation_failed', `Your plan includes ${limit} automations. Archive one or upgrade to add another.`);
          const values = { ...columnsFrom(input), slug: await freeSlug(t, input.name), any_mode_acknowledged: input.anyModeAcknowledged ? new Date() : null, created_by: createdBy };
          const columns = Object.keys(values);
          const [row] = await t.query(
            `INSERT INTO automations (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
            [tenantId(), ...Object.values(values)],
          );
          await saveChildren(t, row.id, input);
          await writeAudit(t, { actor, action: 'automation.create', target: `automation:${row.id}`, details: { triggerType: input.triggerType } });
          return row.id;
        });
        return await load(db, id);
      } catch (err) {
        throw friendly(err);
      }
    },

    get: (id) => load(db, id),

    async update(id, input, { actor }) {
      try {
        const saved = await db.tx(async (t) => {
          const [current] = await t.query('SELECT state, any_mode_acknowledged, link_url FROM automations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
          if (!current) return false;
          const values = columnsFrom(input);
          if (input.anyModeAcknowledged && !current.any_mode_acknowledged) values.any_mode_acknowledged = new Date();
          if (input.linkUrl !== undefined && input.linkUrl !== current.link_url) values.link_status = 'unchecked';
          const columns = Object.keys(values);
          await t.query(
            `UPDATE automations SET ${[...columns.map((c, i) => `${c} = $${i + 3}`), 'updated_at = now()'].join(', ')} WHERE tenant_id = $1 AND id = $2`,
            [tenantId(), id, ...Object.values(values)],
          );
          await saveChildren(t, id, input, { triggersActive: current.state !== 'archived' });
          await writeAudit(t, { actor, action: 'automation.update', target: `automation:${id}`, details: { fields: Object.keys(input) } });
          return true;
        });
        return saved ? await load(db, id) : null;
      } catch (err) {
        throw friendly(err);
      }
    },

    async list({ state, cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        `SELECT a.id, a.name, a.state, a.trigger_type, a.link_mode, a.updated_at,
           (SELECT count(*)::int FROM automation_triggers t WHERE t.tenant_id = a.tenant_id AND t.automation_id = a.id AND t.active AND t.media_id <> '') AS media_count,
           (SELECT count(*)::int FROM outbound_jobs j WHERE j.tenant_id = a.tenant_id AND j.automation_id = a.id AND j.purpose = 'trigger' AND j.status IN ${SENT} AND NOT j.is_test) AS sends
         FROM automations a WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.state = $2) AND ($3::int IS NULL OR a.id < $3) ORDER BY a.id DESC LIMIT $4`,
        [tenantId(), state ?? null, after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((row) => ({ id: row.id, name: row.name, state: row.state, triggerType: row.trigger_type, linkMode: row.link_mode, mediaCount: row.media_count, sends: row.sends, updatedAt: row.updated_at })),
      };
    },

    /** Moves an automation to `state`. Null when there is no such automation; a change the states don't allow is refused. */
    async setState(id, state, { actor }) {
      try {
        const changed = await db.tx(async (t) => {
          const [row] = await t.query('SELECT state, ends_at FROM automations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
          if (!row) return false;
          if (row.state === state) return true;
          if (!TRANSITIONS[row.state].includes(state)) throw new ApiError('conflict', `A ${row.state} automation can’t become ${state}.`);
          if (['test', 'live'].includes(state) && row.ends_at && new Date(row.ends_at) <= new Date()) throw new ApiError('conflict', 'This automation’s end date has passed. Change the schedule first.');
          await t.query(
            `UPDATE automations SET state = $3, paused_reason = $4, archived_at = CASE WHEN $3::text = 'archived' THEN now() ELSE NULL END, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
            [tenantId(), id, state, state === 'paused' ? 'paused.automation' : ''],
          );
          if (row.state === 'archived' || state === 'archived') {
            await t.query('UPDATE automation_triggers SET active = $3 WHERE tenant_id = $1 AND automation_id = $2', [tenantId(), id, state !== 'archived']);
          }
          await writeAudit(t, { actor, action: 'automation.state', target: `automation:${id}`, details: { from: row.state, to: state } });
          return true;
        });
        return changed ? await load(db, id) : null;
      } catch (err) {
        throw friendly(err);
      }
    },

    /** Deletes an automation that never sent anything. One with history is archived, so its numbers stay. False when there is none. */
    async remove(id, { actor }) {
      return db.tx(async (t) => {
        const [row] = await t.query('SELECT state FROM automations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
        if (!row) return false;
        const [history] = await t.query('SELECT 1 FROM outbound_jobs WHERE tenant_id = $1 AND automation_id = $2 LIMIT 1', [tenantId(), id]);
        if (history) {
          await t.query(`UPDATE automations SET state = 'archived', archived_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]);
          await t.query('UPDATE automation_triggers SET active = false WHERE tenant_id = $1 AND automation_id = $2', [tenantId(), id]);
        } else {
          await t.query('DELETE FROM automations WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
        }
        await writeAudit(t, { actor, action: 'automation.remove', target: `automation:${id}`, details: { archived: Boolean(history) } });
        return true;
      });
    },

    async pickWinner(id, variantId, { actor }) {
      const picked = await db.tx(async (t) => {
        const [automation] = await t.query('SELECT id FROM automations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
        if (!automation) return false;
        const [variant] = await t.query(
          `SELECT v.id FROM template_variants v JOIN message_templates m ON m.tenant_id = v.tenant_id AND m.id = v.template_id
           WHERE v.tenant_id = $1 AND v.id = $2 AND v.active AND m.automation_id = $3 AND m.role = 'first_dm'`,
          [tenantId(), variantId, id],
        );
        if (!variant) throw new ApiError('validation_failed', 'That version isn’t part of this automation.', { fields: { variantId: 'Pick one of this automation’s versions' } });
        await t.query('UPDATE automations SET winner_variant_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), id, variantId]);
        await writeAudit(t, { actor, action: 'automation.winner', target: `automation:${id}`, details: { variantId } });
        return true;
      });
      return picked ? load(db, id) : null;
    },

    /** Sends and taps per version, leaving out testers, test mode and dry runs (PRD 6.5, 6.9). */
    async stats(automation, { minSendsForLeader = 100 } = {}) {
      const canCountTaps = automation.triggerType === 'comment' && automation.linkMode === 'two_tap';
      const sends = await db.query(
        `SELECT variant_id, count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1 AND automation_id = $2 AND purpose = 'trigger' AND status IN ${SENT} AND NOT is_test GROUP BY variant_id`,
        [tenantId(), automation.id],
      );
      const taps = canCountTaps
        ? await db.query('SELECT variant_id, count(*)::int AS n FROM link_taps WHERE tenant_id = $1 AND automation_id = $2 AND NOT is_test GROUP BY variant_id', [tenantId(), automation.id])
        : [];
      const count = (rows, id) => rows.find((r) => r.variant_id === id)?.n ?? 0;
      const variants = automation.variants.map((v) => {
        const sent = count(sends, v.id);
        const tapped = canCountTaps ? count(taps, v.id) : null;
        return { variantId: v.id, label: v.label, sends: sent, taps: tapped, visits: null, rate: canCountTaps && sent ? tapped / sent : null, leader: false };
      });
      if (variants.length > 1 && canCountTaps && variants.every((v) => v.sends >= minSendsForLeader)) {
        const best = variants.reduce((a, b) => (b.rate > a.rate ? b : a));
        if (variants.filter((v) => v.rate === best.rate).length === 1) best.leader = true;
      }
      return { automationId: automation.id, sends: sends.reduce((sum, r) => sum + r.n, 0), taps: canCountTaps ? taps.reduce((sum, r) => sum + r.n, 0) : null, variants };
    },

    // ---- What the engine reads and writes while handling an event ----

    /** The automation an active trigger maps this media to, in any state but archived. */
    async forMedia(channel, mediaId) {
      const rows = await db.query(
        `SELECT a.* FROM automation_triggers t JOIN automations a ON a.tenant_id = t.tenant_id AND a.id = t.automation_id
         WHERE t.tenant_id = $1 AND t.channel = $2 AND t.media_id = $3 AND t.active LIMIT 1`,
        [tenantId(), channel, String(mediaId)],
      );
      return (await hydrate(db, rows))[0] ?? null;
    },

    /** The business's "any story reply" automation. */
    async anyStory(channel) {
      const rows = await db.query(
        `SELECT a.* FROM automation_triggers t JOIN automations a ON a.tenant_id = t.tenant_id AND a.id = t.automation_id
         WHERE t.tenant_id = $1 AND t.channel = $2 AND t.target_type = 'any_story' AND t.active LIMIT 1`,
        [tenantId(), channel],
      );
      return (await hydrate(db, rows))[0] ?? null;
    },

    /** Automations of a type that aren't tied to one post, highest priority first. With no trigger row, one is for Instagram. */
    async byType(triggerType, channel) {
      const rows = await db.query(
        `SELECT a.* FROM automations a WHERE a.tenant_id = $1 AND a.trigger_type = $2 AND a.state IN ('live', 'test')
           AND (EXISTS (SELECT 1 FROM automation_triggers t WHERE t.tenant_id = a.tenant_id AND t.automation_id = a.id AND t.active AND t.channel = $3::text)
                OR ($3::text = 'instagram' AND NOT EXISTS (SELECT 1 FROM automation_triggers t WHERE t.tenant_id = a.tenant_id AND t.automation_id = a.id)))
         ORDER BY a.priority DESC, a.id`,
        [tenantId(), triggerType, channel],
      );
      return hydrate(db, rows);
    },

    /** media_product_type decides the label shown in activity (PRD 6.1). */
    async relabelTrigger(channel, mediaId, label) {
      await db.query(
        `UPDATE automation_triggers SET target_type = $4 WHERE tenant_id = $1 AND channel = $2 AND media_id = $3 AND target_type IN ('reel', 'post') AND target_type <> $4`,
        [tenantId(), channel, String(mediaId), label],
      );
    },

    async sendSettings() {
      const [row] = await db.query('SELECT utm_enabled FROM compliance_settings WHERE tenant_id = $1', [tenantId()]);
      return { utm: row?.utm_enabled ?? true };
    },

    /** Hosts no DM may link to, for linkProblem. */
    async blockedHosts() {
      const rows = await db.query('SELECT host, category FROM link_blocked_hosts');
      return new Map(rows.map((row) => [row.host, row.category]));
    },

    async timeZone() {
      const [row] = await db.query('SELECT timezone FROM tenants WHERE id = $1', [tenantId()]);
      return row?.timezone;
    },

    /** Per-reel ids for the link (PRD 6.6). */
    async measurement(mediaId) {
      const rows = await db.query('SELECT kind, network, value FROM measurement_ids WHERE tenant_id = $1 AND media_id = $2', [tenantId(), String(mediaId)]);
      const find = (kind) => rows.find((r) => r.kind === kind);
      return { amazonTag: find('amazon_tag')?.value, subId: find('affiliate_sub_id')?.value, network: find('affiliate_sub_id')?.network };
    },

    /** The last trigger DM this person has been sent before `before`, or null. */
    async lastTriggerDm(channel, subject, before) {
      const [row] = await db.query(
        `SELECT automation_id, is_test FROM outbound_jobs
         WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3 AND purpose = 'trigger' AND status IN ${SENT} AND automation_id IS NOT NULL AND COALESCE(sent_at, updated_at) <= $4
         ORDER BY id DESC LIMIT 1`,
        [tenantId(), channel, subject, before],
      );
      return row ?? null;
    },


    async jobExists(idempotencyKey) {
      const [row] = await db.query('SELECT 1 FROM outbound_jobs WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId(), idempotencyKey]);
      return Boolean(row);
    },

    /** Marks a job just created as waiting for its automation's hours (PRD 6.8). */
    async holdJob(jobId, at) {
      await db.query(`UPDATE outbound_jobs SET status = 'held', reason = 'outside_hours', run_at = $3, updated_at = $3 WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'held')`, [tenantId(), jobId, at]);
    },
  };
}
