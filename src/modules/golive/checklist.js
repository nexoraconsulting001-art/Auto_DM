import fs from 'node:fs';
import { SECRET_SETTINGS } from '../../config.js';
import { GOLIVE_DETAILS, GOLIVE_ITEMS, GOLIVE_STATES, GoliveAttestation, GoliveStatus, blockingOpen, isTestValue } from '../../contracts/golive.js';
import { CHOSEN_PROVIDER_SETTINGS, SIMULATOR_SETTINGS, looksLikeSimulator, looksLikeTestKey } from '../../platform/production-guard.js';
import { PROBES, probeWorld } from './probes.js';

/**
 * The go-live checklist itself (G-15 to G-17): every item of GOLIVE_ITEMS checked the way its `check.kind` says, and
 * nothing else deciding readiness. See index.js for who calls it.
 *
 * What holds whatever the input:
 * - No value of any setting leaves here. A detail is a fixed phrase (DETAIL), followed at most by setting names.
 * - A missing, blank or test value (a simulator or test address, a test-mode key, a placeholder) is never ready, and a
 *   probe whose adapter points anywhere but the provider is never run, let alone ready.
 * - A probe that fails, throws or does not answer within its time is unknown ("not checked"), never ready.
 * - A sign-off counts only as a valid entry: a named person (two letters or more), a role, a real calendar date that is
 *   not in the future and not older than the item allows.
 */

/** Phrases the contract's GOLIVE_DETAILS does not have; fixed text, never a value. */
export const GOLIVE_EXTRA_DETAILS = Object.freeze({
  notChecked: 'NOT CHECKED',
  notApproved: 'Not approved yet.',
  notVerified: 'Not verified yet.',
  refused: 'The service refused the credentials.',
  notSubscribed: 'Not subscribed to every field the code handles.',
  wrongAddress: 'Points at another address than the platform’s.',
  notAnswering: 'Does not answer at the public address.',
  acceptsUnsigned: 'The deletion callback accepts an unsigned request.',
  unreadable: 'The credential cannot be read.',
  localOnly: 'Checked here only: the service has no read-only check.',
  doesNotResolve: 'A platform host does not resolve.',
  certificate: 'A certificate is invalid or has 14 days or fewer left.',
  backupOld: 'No backup finished in the last 26 hours.',
  drillNotPassed: 'No passing restore drill in the last 90 days.',
  notScraped: 'Nothing is being scraped.',
  noReceiver: 'Alerts reach nobody.',
  notEnvelope: 'Some stored secrets are not under the current key in the envelope form.',
  brokenRule: 'Breaks a production rule.',
  signOffInvalid: 'The sign-off file is not valid.',
  signOffBadEntry: 'The sign-off has no valid name, role or date.',
});
export const DETAIL = Object.freeze({ ...GOLIVE_DETAILS, ...GOLIVE_EXTRA_DETAILS });

const DAY = 86_400_000;
const NAME = /^[A-Z][A-Z0-9_]{1,60}$/;
const camel = (name) => name.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const configKeyOf = (name) => SECRET_SETTINGS[name] ?? SIMULATOR_SETTINGS[name] ?? CHOSEN_PROVIDER_SETTINGS[name] ?? camel(name);
const looksLikeUrl = (v) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
/**
 * The settings a detail may name after its phrase: the secrets, the settings the items list, and the provider addresses.
 * A setting outside this list (PLATFORM_DOMAIN, PROMETHEUS_URL, ...) gets the phrase alone; its item's next step names it.
 */
export const NAMED_SETTINGS = Object.freeze(new Set([
  ...Object.keys(SECRET_SETTINGS), ...Object.keys(SIMULATOR_SETTINGS), ...Object.keys(CHOSEN_PROVIDER_SETTINGS),
  ...GOLIVE_ITEMS.flatMap((i) => [...(i.check.all ?? []), ...(i.check.any ?? [])]),
]));

/** Reads one setting by its environment name: the running config first, then the environment for names it has no key for. */
export function settingReader(config, env = process.env) {
  return (name) => {
    let v = config?.[configKeyOf(name)];
    if (v === undefined || v === null || v === '') v = env?.[name];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).trim();
  };
}

/** What is wrong with one setting, as a key of DETAIL, or '' when it is present and looks real. Reads the value; returns no part of it. */
export function settingProblem(name, value) {
  const v = String(value ?? '').trim();
  if (!v) return 'notSet';
  if (looksLikeUrl(v)) {
    if (isTestValue(v) || looksLikeSimulator(v)) return 'simulator';
    return '';
  }
  if (isTestValue(v) || looksLikeTestKey(v)) return 'testValue';
  if (/^RAZORPAY_(BILLING_)?KEY_ID$/.test(name) && !/^rzp_live_[A-Za-z0-9]{6,}$/.test(v)) return 'testValue';
  if (/(^|_)APP_ID$/.test(name) && !/^\d{5,25}$/.test(v)) return 'testValue';
  return '';
}

const detailText = (key, names = []) => {
  const phrase = DETAIL[key] ?? DETAIL.unreachable;
  let text = phrase;
  const shown = [...new Set(names.filter((n) => NAME.test(n)))];
  for (const [i, name] of shown.entries()) {
    const next = `${text}${i ? ',' : ''} ${name}`;
    if (next.length > 185) return `${text} and more`;
    text = next;
  }
  return text;
};

/** The first problem among `names` with every setting that has it, or null when all pass. */
function settingsVerdict(value, names) {
  const problems = names.map((name) => [name, settingProblem(name, value(name))]).filter(([, p]) => p);
  if (!problems.length) return null;
  const order = ['notSet', 'simulator', 'testValue'];
  const first = order.find((p) => problems.some(([, q]) => q === p));
  return { state: 'missing', detail: detailText(first, problems.filter(([n, q]) => q === first && NAMED_SETTINGS.has(n)).map(([n]) => n)) };
}

/** A sign-off's date: a real calendar day, not after tomorrow (time zones), as ms; null when it is not one. */
function signOffDay(date, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date) return null;
  return at > now + DAY ? null : at;
}

/**
 * The sign-off file, entry by entry. A file that is not JSON or not { version: 1, entries: [...] } signs nothing off; an
 * entry that fails GoliveAttestation (no name, a one-letter name, no role, an extra field, an item that is not signed off)
 * or has no real date counts for nothing. Answers { byId: Map(id -> newest valid day), bad: Set(ids), fileProblem }.
 * Nothing of the file's text is kept or returned.
 */
export function readAttestations(file, { now = Date.now(), readFile = fs.readFileSync } = {}) {
  const out = { byId: new Map(), bad: new Set(), fileProblem: '', badEntries: 0 };
  let parsed;
  try {
    parsed = JSON.parse(readFile(file, 'utf8'));
  } catch {
    out.fileProblem = 'unreadable';
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries) || Object.keys(parsed).some((k) => !['version', 'entries'].includes(k))) {
    out.fileProblem = 'invalid';
    return out;
  }
  for (const raw of parsed.entries) {
    const entry = GoliveAttestation.safeParse(raw);
    const day = entry.success ? signOffDay(entry.data.date, now) : null;
    if (!entry.success || day === null) {
      out.badEntries += 1;
      if (typeof raw?.id === 'string') out.bad.add(raw.id);
      continue;
    }
    out.byId.set(entry.data.id, Math.max(out.byId.get(entry.data.id) ?? 0, day));
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ state: 'unknown', detail: 'unreachable' }), ms);
      timer.unref?.();
    }),
  ]);
}

/** A probe's answer as the checklist reports it: only a known state, only a fixed phrase. */
function cleanVerdict(raw) {
  const state = GOLIVE_STATES.includes(raw?.state) ? raw.state : 'unknown';
  if (state === 'ready') return { state, detail: DETAIL.ok };
  const key = Object.hasOwn(DETAIL, raw?.detail) && raw.detail !== 'ok' ? raw.detail : state === 'missing' ? 'notSet' : 'unreachable';
  return { state, detail: detailText(key, Array.isArray(raw?.names) ? raw.names : []) };
}

/**
 * createGolive(ctx, options) -> { status({ live }), signupVerdict(), attestations() }
 *
 * ctx: { config, db, platform } as the app and worker have it (db and platform optional: the database's items are then
 * not checked). options, for tests and the command: env, now, timeoutMs (each probe), readFile, attestationsFile,
 * bases (provider addresses for tests: never read from the configuration), world (replaces DNS, TLS, the WhatsApp adapter),
 * probes (replaces probe functions by name).
 */
export function createGolive(ctx = {}, options = {}) {
  const config = ctx.config ?? {};
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = Math.max(200, Math.min(30_000, Number(options.timeoutMs) || 8_000));
  const value = settingReader(config, env);
  const db = ctx.db?.platform ?? ctx.db ?? null;
  const world = probeWorld(config, { whatsapp: ctx.providers?.whatsapp, ...options.world });
  const probes = { ...PROBES, ...options.probes };
  const attestationsFile = options.attestationsFile ?? config.goliveAttestations ?? 'deploy/golive/attestations.json';
  const readFile = options.readFile ?? fs.readFileSync;

  const probeContext = () => ({ config, value, bases: { ...options.bases }, timeoutMs, now, db, secrets: ctx.platform?.secrets ?? options.secrets, ...world });

  async function probeItem(item, live) {
    const def = probes[item.check.probe];
    if (!def) return { state: 'unknown', detail: DETAIL.notBuilt };
    const settings = settingsVerdict(value, def.settings ?? []);
    if (settings) return settings;
    const pointed = (def.simulators ?? []).filter((name) => value(name));
    if (pointed.length) return { state: 'missing', detail: detailText('simulator', pointed.filter((n) => NAMED_SETTINGS.has(n))) };
    const chosen = settingsVerdict(value, def.chosen ?? []);
    if (chosen) return chosen;
    if (!live && !def.local) return { state: 'unknown', detail: DETAIL.notChecked };
    try {
      return cleanVerdict(await withTimeout(Promise.resolve().then(() => def.run(probeContext(), item.check.args ?? {})), timeoutMs + 250));
    } catch {
      return { state: 'unknown', detail: DETAIL.unreachable };
    }
  }

  function attestationItem(item, signed) {
    if (signed.fileProblem) return { state: 'missing', detail: DETAIL.signOffInvalid };
    const day = signed.byId.get(item.id);
    if (day === undefined) return { state: 'missing', detail: signed.bad.has(item.id) ? DETAIL.signOffBadEntry : DETAIL.notSignedOff };
    if ((now() - day) / DAY > item.check.maxAgeDays) return { state: 'missing', detail: DETAIL.signOffExpired };
    return { state: 'ready', detail: DETAIL.ok };
  }

  async function businessCounts() {
    if (!db) return null;
    try {
      const [{ n }] = await db.query('SELECT count(*)::int AS n FROM tenants');
      const rows = await db.query(`SELECT step, count(*) FILTER (WHERE status = 'done')::int AS done FROM onboarding_steps GROUP BY step`);
      return { total: Number(n), done: new Map(rows.map((r) => [r.step, Number(r.done)])) };
    } catch {
      return null;
    }
  }

  function perBusinessItem(item, counts) {
    const done = counts?.done.get(item.check.step);
    if (done === undefined) return { state: 'unknown', detail: DETAIL.perBusiness };
    return { state: 'unknown', detail: `${DETAIL.perBusiness} ${done} of ${counts.total} so far.` };
  }

  let inFlight = null;
  async function build(live) {
    const signed = readAttestations(attestationsFile, { now: now(), readFile });
    const counts = live || db ? await businessCounts() : null;
    const items = await Promise.all(GOLIVE_ITEMS.map(async (item) => {
      let verdict;
      if (item.check.kind === 'setting') {
        const all = settingsVerdict(value, item.check.all);
        const anyOk = !item.check.any.length || item.check.any.some((name) => !settingProblem(name, value(name)));
        verdict = all ?? (anyOk ? { state: 'ready', detail: DETAIL.ok } : settingsVerdict(value, item.check.any));
      } else if (item.check.kind === 'attestation') verdict = attestationItem(item, signed);
      else if (item.check.kind === 'per_business') verdict = perBusinessItem(item, counts);
      else verdict = await probeItem(item, live);
      return { id: item.id, title: item.title, owner: item.owner, phase: item.phase, blocks: item.blocks, kind: item.check.kind, state: verdict.state, detail: verdict.detail };
    }));
    const open = blockingOpen(items);
    const status = GoliveStatus.parse({ ready: open.length === 0, blockingMissing: open.length, checkedAt: new Date(now()), deployEnv: String(config.deployEnv ?? '').slice(0, 20), items });
    return Object.assign(status, { signOffs: { fileProblem: signed.fileProblem, badEntries: signed.badEntries } });
  }

  return {
    /** GoliveStatus. `live` runs the probes that ask an outside service; without it they are "not checked". */
    async status({ live = false } = {}) {
      if (!live) return build(false);
      // One live run at a time per process: a console that is refreshed does not multiply the calls to providers.
      inFlight ??= build(true).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    /** SignupGuardVerdict for opening sign-up to the public: ok only when no blocking item is open, after a live check. */
    async signupVerdict() {
      const status = await this.status({ live: true });
      const missing = blockingOpen(status.items).map((i) => i.id);
      return { ok: missing.length === 0, missing };
    },
  };
}
