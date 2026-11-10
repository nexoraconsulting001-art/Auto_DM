import { DESTINATION_SOURCES } from '../../contracts/analytics.js';
import { pageOfFetched, readCursor, isRowId } from '../admin-api/paging.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { clockOf, localParts, timeZoneOf } from './time.js';

const TRACKING_HEADERS = ['tracking id', 'tracking_id', 'trackingid', 'tag', 'sub id', 'sub_id', 'subid', 'sub-id', 'clickref', 'click ref'];
const EARNING_HEADERS = ['ad fees', 'earnings', 'commission', 'bounty', 'payout', 'amount'];
const DATE_HEADERS = ['date', 'date shipped', 'shipment date', 'order date', 'day'];
const ORDER_HEADERS = ['items shipped', 'orders', 'conversions', 'items ordered'];

// Days as text: a driver turning a date into a moment would move it across midnight.
const UPLOAD_COLUMNS = 'id, source, network, period_from::text AS period_from, period_to::text AS period_to, rows_imported, rows_unmatched, uploaded_at';

const normal = (value) => String(value ?? '').trim().toLowerCase();

/** One CSV line, keeping commas inside quotes. */
function splitLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

/** ₹1,234.50 as 123450 paise, without passing through a floating-point number. */
export function paiseOf(text) {
  const digits = String(text ?? '').replace(/[^\d.]/g, '');
  if (!digits || digits === '.') return null;
  const [whole, fraction = ''] = digits.split('.');
  return Number(whole || 0) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

function dayOf(text) {
  const value = String(text ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(value);
  return Number.isNaN(+parsed) ? null : parsed.toISOString().slice(0, 10);
}

const columnOf = (headers, names) => headers.findIndex((h) => names.some((name) => h === name || h.startsWith(`${name} `)));

/** An earnings report as rows of { tracking, day, earningsPaise, orders }. The header needn't be the first line: Amazon's reports open with a title. */
export function parseEarningsReport(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  const start = lines.findIndex((line) => {
    const headers = splitLine(line).map(normal);
    return columnOf(headers, TRACKING_HEADERS) !== -1 && columnOf(headers, EARNING_HEADERS) !== -1;
  });
  if (start === -1) throw new ValidationError('This report needs a tracking ID column and an earnings column.');
  const headers = splitLine(lines[start]).map(normal);
  const [tracking, earnings, date, orders] = [columnOf(headers, TRACKING_HEADERS), columnOf(headers, EARNING_HEADERS), columnOf(headers, DATE_HEADERS), columnOf(headers, ORDER_HEADERS)];
  return lines.slice(start + 1).map((line) => {
    const cells = splitLine(line);
    return { tracking: String(cells[tracking] ?? '').trim(), day: date === -1 ? null : dayOf(cells[date]), earningsPaise: paiseOf(cells[earnings]), orders: orders === -1 ? null : Number.parseInt(cells[orders], 10) || 0 };
  }).filter((row) => row.tracking);
}

/** What the destination reported (7.15). Every figure read from here is labelled "From the destination" and is never added to Bhava's own. */
export function createDestinations(ctx) {
  const { db, config } = ctx;
  const now = clockOf(config);

  async function connections() {
    const rows = await db.query('SELECT source, enabled, connected_at FROM destination_connections WHERE tenant_id = $1', [tenantId()]);
    return { items: DESTINATION_SOURCES.map((source) => {
      const row = rows.find((r) => r.source === source);
      return { source, enabled: Boolean(row?.enabled), connectedAt: row?.connected_at ?? null };
    }) };
  }

  /** The tag a seller pastes on their own site. It reports visits that arrived with a reel's UTM tags, to this seller's own address, and nothing about who. */
  const snippet = (host) => `<script>(function(){var q=new URLSearchParams(location.search),c=q.get('utm_content');if(!c)return;navigator.sendBeacon('https://${host}/_t/d?m='+encodeURIComponent(c));})();</script>`;

  async function setSiteTag({ enabled }, host) {
    await db.query(
      `INSERT INTO destination_connections (tenant_id, source, enabled, connected_at, updated_at) VALUES ($1, 'site_tag', $2, CASE WHEN $2 THEN now() ELSE NULL END, now())
       ON CONFLICT (tenant_id, source) DO UPDATE SET enabled = EXCLUDED.enabled, connected_at = COALESCE(destination_connections.connected_at, EXCLUDED.connected_at), updated_at = now()`,
      [tenantId(), enabled],
    );
    return { enabled, snippet: enabled ? snippet(host) : '' };
  }

  /** One visit reported by the seller's own site. Off unless the seller turned the tag on. */
  async function recordSiteVisit(mediaId) {
    const [on] = await db.query(`SELECT 1 FROM destination_connections WHERE tenant_id = $1 AND source = 'site_tag' AND enabled`, [tenantId()]);
    if (!on) return false;
    const day = localParts(new Date(now()), await timeZoneOf(db)).day;
    await db.query(
      `INSERT INTO destination_figures (tenant_id, source, network, media_id, day, visits) VALUES ($1, 'site_tag', '', $2, $3::date, 1)
       ON CONFLICT (tenant_id, source, network, media_id, day) DO UPDATE SET visits = COALESCE(destination_figures.visits, 0) + 1, fetched_at = now()`,
      [tenantId(), mediaId, day],
    );
    return true;
  }

  async function reports({ cursor, limit }) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
    const rows = await db.query(`SELECT ${UPLOAD_COLUMNS} FROM destination_uploads WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [tenantId(), after, limit + 1]);
    const page = pageOfFetched(rows, limit, (row) => [row.id]);
    return { items: page.items.map(toUpload), nextCursor: page.nextCursor };
  }

  /** Reads an uploaded earnings report and credits each row to the reel with that tracking id. A row with no such reel is counted as unmatched and credited to nobody. */
  async function upload({ source, network }, file, user) {
    const rows = parseEarningsReport(file.buffer.toString('utf8'));
    const kind = source === 'amazon' ? 'amazon_tag' : 'affiliate_sub_id';
    const ids = await db.query('SELECT media_id, value, network FROM measurement_ids WHERE tenant_id = $1 AND kind = $2', [tenantId(), kind]);
    const mediaOf = new Map(ids.filter((r) => source === 'amazon' || !network || r.network === network).map((r) => [r.value, r.media_id]));
    const today = localParts(new Date(now()), await timeZoneOf(db)).day;
    const figures = new Map();
    let unmatched = 0;
    for (const row of rows) {
      const mediaId = mediaOf.get(row.tracking);
      if (!mediaId || row.earningsPaise === null) {
        unmatched += 1;
        continue;
      }
      const day = row.day ?? today;
      const key = `${mediaId}|${day}`;
      const figure = figures.get(key) ?? { mediaId, day, earnings: 0, orders: null };
      figure.earnings += row.earningsPaise;
      if (row.orders !== null) figure.orders = (figure.orders ?? 0) + row.orders;
      figures.set(key, figure);
    }
    const days = rows.map((r) => r.day).filter(Boolean).sort();
    const matched = rows.length - unmatched;
    return db.tx(async (t) => {
      const [saved] = await t.query(
        `INSERT INTO destination_uploads (tenant_id, source, network, period_from, period_to, rows_imported, rows_unmatched, uploaded_by) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8) RETURNING ${UPLOAD_COLUMNS}`,
        [tenantId(), source, network, days[0] ?? null, days.at(-1) ?? null, matched, unmatched, user.id],
      );
      for (const figure of figures.values()) {
        await t.query(
          `INSERT INTO destination_figures (tenant_id, source, network, media_id, day, orders, earnings_paise, upload_id) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)
           ON CONFLICT (tenant_id, source, network, media_id, day) DO UPDATE SET orders = EXCLUDED.orders, earnings_paise = EXCLUDED.earnings_paise, upload_id = EXCLUDED.upload_id, fetched_at = now()`,
          [tenantId(), source, network, figure.mediaId, figure.day, figure.orders, figure.earnings, saved.id],
        );
      }
      await t.query(
        `INSERT INTO destination_connections (tenant_id, source, enabled, connected_at, updated_at) VALUES ($1, $2, true, now(), now())
         ON CONFLICT (tenant_id, source) DO UPDATE SET enabled = true, connected_at = COALESCE(destination_connections.connected_at, now()), updated_at = now()`,
        [tenantId(), source],
      );
      return toUpload(saved);
    });
  }

  return { connections, setSiteTag, recordSiteVisit, reports, upload };
}

const toUpload = (row) => ({ id: row.id, source: row.source, network: row.network, periodFrom: row.period_from, periodTo: row.period_to, rowsImported: row.rows_imported, rowsUnmatched: row.rows_unmatched, uploadedAt: row.uploaded_at });
