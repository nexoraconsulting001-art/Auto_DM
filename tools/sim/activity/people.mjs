/**
 * The check behind "every sample customer is invented" (Q-02): finds anything in a text, a catalogue or the database that
 * looks like a person and is not one of PEOPLE_RULES. It answers WHERE, never WHAT: a finding names a kind, a file or a table
 * and column, and how many, so the check itself can never print someone's number into a log.
 *
 *   findOutsiders(text)                   [{ kind: 'phone' | 'email' | 'handle' | 'instagramId', count }] in a piece of text
 *   scanDatabase(query)                   [{ table, column, kind, count }] over the identity columns of every table
 *
 * `query(sql, params)` is any function that answers rows (db.platform.query).
 */
import { PEOPLE_RULES, problemsWithPerson } from '../../../src/contracts/seed.js';

const MOBILE = /(?<![\d])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HANDLE = /(?:instagram\.com\/|(?<![\w.])@)([A-Za-z0-9._]{3,30})/g;

/** +91 and 10 digits, from any of the ways a number is written. Null when it is not an Indian mobile number. */
export function toE164(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return `+${digits}`;
  return null;
}

const phoneInvented = (raw) => PEOPLE_RULES.phone.pattern.test(toE164(raw) ?? '');
const emailInvented = (email) => problemsWithPerson({ name: 'Aarohi Ambekar', phone: '+919000000000', email }).length === 0;
const handleInvented = (handle) => PEOPLE_RULES.instagram.username.test(handle.toLowerCase());

/** What looks like a person in `text` and is not invented. */
export function findOutsiders(text) {
  const found = new Map();
  const add = (kind) => found.set(kind, (found.get(kind) ?? 0) + 1);
  const body = String(text ?? '');
  for (const match of body.matchAll(MOBILE)) if (!phoneInvented(match[0])) add('phone');
  for (const match of body.matchAll(EMAIL)) if (!emailInvented(match[0])) add('email');
  for (const match of body.matchAll(HANDLE)) if (!handleInvented(match[1])) add('handle');
  return [...found].map(([kind, count]) => ({ kind, count }));
}

/** Columns that hold a person's identity, by what they are called. A business's own name, slug or address is not a person. */
const KINDS = [
  { kind: 'phone', column: /^(phone|mobile|display_number|pickup_phone|contact_phone|owner_phone|wa_id)$|_phone$/, ok: (v) => phoneInvented(v) },
  { kind: 'email', column: /^(email|contact_email|owner_email|pickup_email)$|_email$/, ok: (v) => v === '' || emailInvented(v) },
  { kind: 'instagramId', column: /^(recipient_id|ig_user_id|igsid|sender_id)$/, ok: (v) => PEOPLE_RULES.instagram.id.test(v) || phoneInvented(v) }, // a WhatsApp thread is keyed by the shopper's number
  { kind: 'handle', column: /^(username|ig_username|handle)$/, ok: (v) => v === '' || handleInvented(v) || nameOk(v) }, // WhatsApp gives a profile name where Instagram gives a handle
];
/** Tables where `name` is a person's name. */
const PERSON_NAMES = [
  ['users', 'name'], ['shoppers', 'name'], ['shopper_addresses', 'name'], ['orders', 'customer_name'], ['shared_profiles', 'name'], ['leads', 'name'], ['reviews', 'display_name'],
];

function nameOk(value) {
  const parts = String(value).split(' ');
  return parts.length === 2 && PEOPLE_RULES.names.first.includes(parts[0]) && PEOPLE_RULES.names.last.includes(parts[1]);
}

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Every identity column of the database: what is in it that is not invented. Empty means every person is. */
export async function scanDatabase(query) {
  const columns = await query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'character')`);
  const problems = [];
  const check = async (table, column, kind, ok) => {
    const rows = await query(`SELECT DISTINCT ${quote(column)} AS v FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL AND ${quote(column)} <> ''`);
    const bad = rows.filter((r) => !ok(String(r.v)));
    if (bad.length) problems.push({ table, column, kind, count: bad.length });
  };
  for (const { table_name: table, column_name: column } of columns) {
    if (table === 'schema_migrations' || table === 'theme_presets') continue;
    for (const k of KINDS) if (k.column.test(column)) await check(table, column, k.kind, k.ok);
    if (PERSON_NAMES.some(([t, c]) => t === table && c === column)) await check(table, column, 'name', nameOk);
  }
  return problems;
}

/** The people in a catalogue or a seed, as text to scan: every field that could carry one. */
export const textOf = (value) => JSON.stringify(value);
