import crypto from 'node:crypto';
import { APP_ENTITLEMENTS, namesPlatform } from '../../contracts/apps.js';
import { ApiError } from '../../contracts/api/errors.js';
import { StoreAccessUpdate } from '../../contracts/api/apps.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

/**
 * The business's own developer accounts and our access to them (PRD 10.9). See index.js for the interface.
 *
 * Keys: the App Store Connect .p8 is checked to be an EC private key, then stored with platform.secrets as JSON that also names
 * the business, the platform and the key id; credentials() decrypts it only inside that business and only when all three still
 * match the row, so a copied ciphertext is useless anywhere else. It is answered only as its last four characters. Play access is
 * our one service account, which the owner invites; no Google or Apple password is ever taken (StoreAccessUpdate is strict).
 */
export const CLOSED_TEST = Object.freeze({ testers: 12, days: 14, cutoff: '2023-11-13T00:00:00.000Z' });
export const DUNS_LOOKUP = Object.freeze({ ios: 'https://developer.apple.com/enroll/duns-lookup/', android: 'https://www.dnb.com/duns-number/lookup.html' });
const DAY_MS = 86_400_000;
const STORE = Object.freeze({ android: 'Google Play', ios: 'the App Store' });
const ROLE_WORDS = Object.freeze({ APP_MANAGER: 'App Manager', ADMIN: 'Admin', DEVELOPER: 'Developer', RELEASE_TO_PRODUCTION: 'Release to production' });
const CHECKED = 'store_access.checked';
const services = new WeakMap();

const bad = (field, message) => new ApiError('validation_failed', message, { fields: { [field]: message } });
const words = (role) => (ROLE_WORDS[role] ? `${role} (${ROLE_WORDS[role]})` : role);
const sameName = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const actorOf = (user) => (Number.isSafeInteger(Number(user?.id)) && Number(user?.id) > 0 ? Number(user.id) : null);

/** The last four characters of the key itself (not its PEM armour), or ''. */
export function keyLast4(pem) {
  const body = String(pem).replace(/-----[A-Z ]+-----/g, '').replace(/[\s=]/g, '');
  return body.length >= 8 ? body.slice(-4) : '';
}

/** Throws unless `pem` is an EC private key, the kind App Store Connect issues as a .p8 file. */
export function checkAscKey(pem) {
  let key;
  try {
    key = crypto.createPrivateKey(String(pem));
  } catch {
    throw bad('ascKey.privateKey', 'This is not an App Store Connect key. Paste the whole .p8 file you downloaded.');
  }
  if (key.asymmetricKeyType !== 'ec') throw bad('ascKey.privateKey', 'This is not an App Store Connect key. Paste the whole .p8 file you downloaded.');
}

/** The closed test's state from what the owner told us, at `now`. */
export function closedTestOf(row, now = new Date()) {
  const needed = row.platform === 'android' && row.account_type === 'personal' && row.play_account_after_cutoff !== false;
  const startedAt = row.closed_test_started_at ? new Date(row.closed_test_started_at) : null;
  const testers = row.closed_test_testers ?? null;
  const daysDone = startedAt ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS)) : 0;
  let status = 'not_needed';
  if (needed) status = !startedAt ? 'required' : daysDone >= CLOSED_TEST.days && (testers ?? 0) >= CLOSED_TEST.testers ? 'done' : 'running';
  return { status, startedAt, testers, testersNeeded: CLOSED_TEST.testers, daysNeeded: CLOSED_TEST.days, daysDone: needed ? daysDone : 0 };
}

const blankRow = (platform) => ({
  platform, account_type: 'unknown', legal_name: '', duns_status: 'unknown', duns_requested_at: null, play_account_after_cutoff: null, closed_test_status: 'not_needed',
  closed_test_started_at: null, closed_test_testers: null, credential_kind: 'none', key_id: '', issuer_id: '', key_enc: null, key_last4: '', access_status: 'not_checked',
  role_found: '', role_needed: '', checked_at: null,
});

export function storeAccessFor(ctx) {
  let found = services.get(ctx);
  if (!found) services.set(ctx, (found = createStoreAccess(ctx)));
  return found;
}

function createStoreAccess(ctx) {
  const { db, config, platform: drivers } = ctx;
  const secrets = drivers.secrets;
  const stores = () => ctx.appStores;
  const roleNeeded = (platform) => String(platform === 'ios' ? config.appStoreRoleNeeded || 'APP_MANAGER' : config.playPermissionNeeded || 'RELEASE_TO_PRODUCTION').toUpperCase();

  const entitled = async (platform) => Boolean(await ctx.repos.entitlements.can(APP_ENTITLEMENTS[platform]));
  async function requireApp(platform) {
    if (!['android', 'ios'].includes(platform)) throw new ApiError('not_found');
    if (!(await entitled(platform))) throw new ApiError('forbidden', 'Your plan doesn’t include your own app on this store.', { reason: 'plan' });
  }

  const rowOf = async (platform, runner = db) => (await runner.query('SELECT * FROM store_access WHERE tenant_id = $1 AND platform = $2', [tenantId(), platform]))[0] ?? null;
  const appIds = async () => (await db.query('SELECT android_package, ios_bundle_id FROM app_configs WHERE tenant_id = $1', [tenantId()]))[0] ?? {};
  async function lastSellerMatch(platform) {
    const [row] = await db.query(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = $2 AND target = $3 ORDER BY id DESC LIMIT 1`, [tenantId(), CHECKED, `store_access:${platform}`]);
    const value = row?.details?.sellerMatches;
    return typeof value === 'boolean' ? value : null;
  }

  function steps(row, { sellerMatches, sellerName }) {
    const platform = row.platform;
    const out = [];
    const personal = row.account_type === 'personal';
    out.push({
      code: 'account_type', done: row.account_type !== 'unknown',
      title: platform === 'ios' ? 'Choose your Apple Developer account type' : 'Choose your Google Play account type',
      warning: personal ? 'A personal account shows your own name as the seller. An organisation account shows your business’s legal name, which we recommend.' : '',
    });
    if (row.account_type === 'organisation') {
      const waiting = row.duns_status === 'waiting';
      const done = row.duns_status === 'have' || row.duns_status === 'not_needed';
      out.push({
        code: 'duns', done,
        title: waiting ? 'Waiting for D-U-N-S' : done ? 'D-U-N-S number' : 'Get a D-U-N-S number',
        warning: done ? '' : `${platform === 'ios' ? 'Apple' : 'Google Play'} needs your business’s D-U-N-S number. It is free and can take up to 30 days. Look yours up or ask for one at ${DUNS_LOOKUP[platform]}`,
      });
    }
    const closed = closedTestOf(row);
    if (closed.status !== 'not_needed') {
      const progress = closed.status === 'running' ? ` So far: ${closed.daysDone} of ${CLOSED_TEST.days} days, ${closed.testers ?? 0} of ${CLOSED_TEST.testers} testers.` : '';
      out.push({
        code: 'closed_testing', done: closed.status === 'done',
        title: `Run a closed test: ${CLOSED_TEST.testers} testers for ${CLOSED_TEST.days} days`,
        warning: closed.status === 'done' ? '' : `Google Play asks personal accounts made after 13 November 2023 to run a closed test first, with at least ${CLOSED_TEST.testers} testers taking part for ${CLOSED_TEST.days} days in a row. Your app can go to production only after that.${progress}`,
      });
    }
    const legalDone = Boolean(row.legal_name) && sellerMatches === true;
    out.push({
      code: 'legal_name', done: legalDone,
      title: 'Your legal name is the seller',
      warning: legalDone ? '' : !row.legal_name ? 'Enter your business’s legal name exactly as the store account shows it.'
        : sellerMatches === false ? `${platform === 'ios' ? 'The App Store' : 'Google Play'} shows ${sellerName ? `“${sellerName}”` : 'a different name'} as the seller, not “${row.legal_name}”. Publish from your business’s own account.`
          : 'Run the access check to confirm the store shows your legal name as the seller.',
    });
    const status = row.access_status;
    const needed = row.role_needed || roleNeeded(platform);
    if (platform === 'ios') {
      out.push({
        code: 'api_key', done: Boolean(row.key_enc) && status === 'ok',
        title: `Create an App Store Connect API key with the ${words(needed)} role`,
        warning: !row.key_enc ? 'In App Store Connect, open Users and Access, then Integrations, and create a key. Never send us your Apple password.'
          : status === 'role_too_low' ? `This key has the ${row.role_found ? words(row.role_found) : 'wrong'} role. Create a key with the ${words(needed)} role or higher.`
            : status === 'invalid' ? 'App Store Connect did not accept this key, or does not have this app. Check the key ID and issuer ID, or create a new key.'
              : status === 'unreachable' ? 'App Store Connect did not answer. Try the check again in a few minutes.'
                : status === 'not_checked' ? 'Run the access check.' : '',
      });
    } else {
      const email = stores()?.googlePlay?.serviceAccountEmail ?? '';
      out.push({
        code: 'release_access', done: status === 'ok',
        title: `Invite ${email || 'our service account'} in your Play Console with the ${words(needed)} permission`,
        warning: status === 'role_too_low' ? `Our account has ${row.role_found ? words(row.role_found) : 'too little access'}. Give it ${words(needed)} for this app.`
          : status === 'invalid' ? 'Google Play did not find this app under our account. Invite our account to this app in your Play Console.'
            : status === 'unreachable' ? 'Google Play did not answer. Try the check again in a few minutes.'
              : status === 'not_checked' ? 'Invite our account, then run the access check. Never send us your Google password.' : '',
      });
    }
    return out;
  }

  function view(row, extra) {
    const closed = closedTestOf(row);
    const platform = row.platform;
    return {
      platform,
      accountType: row.account_type,
      legalName: row.legal_name,
      dunsStatus: row.duns_status,
      dunsLookupUrl: DUNS_LOOKUP[platform],
      closedTest: { status: closed.status, startedAt: closed.startedAt, testers: closed.testers, testersNeeded: CLOSED_TEST.testers, daysNeeded: CLOSED_TEST.days, daysDone: closed.daysDone },
      credential: { kind: row.credential_kind, keyId: row.key_id, issuerId: row.issuer_id, keyLast4: row.key_last4, set: platform === 'ios' ? Boolean(row.key_enc) : row.credential_kind === 'play_service_account' },
      serviceAccountEmail: platform === 'android' ? stores()?.googlePlay?.serviceAccountEmail ?? '' : '',
      access: { status: row.access_status, roleFound: row.role_found, roleNeeded: row.role_needed || roleNeeded(platform), checkedAt: row.checked_at },
      steps: steps(row, extra),
    };
  }

  async function get(platform) {
    await requireApp(platform);
    const row = (await rowOf(platform)) ?? blankRow(platform);
    return view(row, { sellerMatches: await lastSellerMatch(platform), sellerName: null });
  }

  async function list() {
    const platforms = [];
    for (const platform of ['android', 'ios']) if (await entitled(platform)) platforms.push(platform);
    if (!platforms.length) throw new ApiError('forbidden', 'Your plan doesn’t include your own shopper app.', { reason: 'plan' });
    return Promise.all(platforms.map(get));
  }

  async function save(platform, input, user) {
    await requireApp(platform);
    const parsed = StoreAccessUpdate.safeParse(input ?? {});
    if (!parsed.success) throw bad(parsed.error.issues[0]?.path.join('.') || '_', parsed.error.issues[0]?.message ?? 'Check the details and try again.');
    const body = parsed.data;
    const sets = [];
    const params = [];
    const set = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length + 2}`);
    };
    const changed = [];
    if (body.accountType !== undefined) { set('account_type', body.accountType); changed.push('accountType'); }
    if (body.legalName !== undefined) {
      const name = body.legalName;
      if (/[<>]/.test(name)) throw bad('legalName', 'Use your business’s legal name as plain text.');
      if (namesPlatform(name)) throw bad('legalName', 'Use your business’s own legal name.');
      set('legal_name', name); changed.push('legalName');
    }
    if (body.dunsStatus !== undefined) {
      set('duns_status', body.dunsStatus);
      if (body.dunsStatus === 'waiting') sets.push('duns_requested_at = COALESCE(duns_requested_at, now())');
      changed.push('dunsStatus');
    }
    if (body.playAccountAfterCutoff !== undefined) { set('play_account_after_cutoff', body.playAccountAfterCutoff); changed.push('playAccountAfterCutoff'); }
    if (body.closedTest !== undefined) {
      const { startedAt, testers } = body.closedTest;
      if (startedAt !== undefined) {
        const at = startedAt === null ? null : new Date(startedAt);
        if (at && at.getTime() > Date.now() + 60_000) throw bad('closedTest.startedAt', 'The closed test can’t start in the future.');
        if (at && at.getTime() < Date.parse(CLOSED_TEST.cutoff)) throw bad('closedTest.startedAt', 'A closed test can’t have started before 13 November 2023.');
        set('closed_test_started_at', at);
      }
      if (testers !== undefined) set('closed_test_testers', testers);
      changed.push('closedTest');
    }
    if (body.ascKey !== undefined) {
      if (platform !== 'ios') throw bad('ascKey', 'An App Store Connect key is for the iOS app.');
      if (body.ascKey === null) {
        for (const [column, value] of [['credential_kind', 'none'], ['key_id', ''], ['issuer_id', ''], ['key_enc', null], ['key_last4', '']]) set(column, value);
        changed.push('ascKey:removed');
      } else {
        const { keyId, issuerId, privateKey } = body.ascKey;
        checkAscKey(privateKey);
        if (!secrets.configured) throw new ApiError('conflict', 'Keys can’t be stored yet. Please contact support.');
        const sealed = secrets.encrypt(JSON.stringify({ t: tenantId(), p: platform, k: keyId, i: issuerId, pk: String(privateKey) }));
        for (const [column, value] of [['credential_kind', 'asc_api_key'], ['key_id', keyId], ['issuer_id', issuerId], ['key_enc', sealed], ['key_last4', keyLast4(privateKey)]]) set(column, value);
        changed.push('ascKey:set');
      }
      // A new key, or none, has not been checked.
      for (const [column, value] of [['access_status', 'not_checked'], ['role_found', ''], ['checked_at', null]]) set(column, value);
    }
    const actorId = actorOf(user);
    const saved = await db.tx(async (t) => {
      await t.query('INSERT INTO store_access (tenant_id, platform) VALUES ($1, $2) ON CONFLICT (tenant_id, platform) DO NOTHING', [tenantId(), platform]);
      const [locked] = await t.query('SELECT * FROM store_access WHERE tenant_id = $1 AND platform = $2 FOR UPDATE', [tenantId(), platform]);
      const all = [...sets, `updated_by = (SELECT id FROM users WHERE tenant_id = $1 AND id = $${params.length + 3})`, 'updated_at = now()'];
      let [row] = await t.query(`UPDATE store_access SET ${all.join(', ')} WHERE tenant_id = $1 AND platform = $2 RETURNING *`, [tenantId(), platform, ...params, actorId]);
      row ??= locked;
      const closed = closedTestOf(row);
      if (closed.status !== row.closed_test_status) [row] = await t.query('UPDATE store_access SET closed_test_status = $3 WHERE tenant_id = $1 AND platform = $2 RETURNING *', [tenantId(), platform, closed.status]);
      // The audit row names the fields that changed, never a word of a key or a name.
      await writeAudit(t, { actor: actorId ? `user:${actorId}` : 'user:unknown', action: 'store_access.saved', target: `store_access:${platform}`, details: { platform, changed } });
      return row;
    });
    log.info('store_access.saved', { tenantId: tenantId(), platform, changed });
    return view(saved, { sellerMatches: await lastSellerMatch(platform), sellerName: null });
  }

  /** The decrypted key of this business's own row, or null. Never leaves the submit path. */
  function openKey(row) {
    if (!row?.key_enc || row.credential_kind !== 'asc_api_key') return null;
    try {
      const sealed = JSON.parse(secrets.decrypt(row.key_enc));
      if (sealed.t !== tenantId() || sealed.p !== row.platform || sealed.k !== row.key_id) return null;
      return { keyId: row.key_id, issuerId: row.issuer_id, privateKey: sealed.pk };
    } catch {
      return null;
    }
  }

  async function check(platform, user) {
    await requireApp(platform);
    const needed = roleNeeded(platform);
    const row = (await rowOf(platform)) ?? blankRow(platform);
    const ids = await appIds();
    let result = { status: 'invalid', roleFound: '', roleNeeded: needed };
    let sellerName = null;
    try {
      if (platform === 'ios') {
        const key = openKey(row);
        if (key && ids.ios_bundle_id) {
          const asc = stores().appStoreConnect.forKey(key);
          result = await asc.checkAccess({ bundleId: ids.ios_bundle_id });
          if (result.status === 'ok') sellerName = (await asc.reviewState({ bundleId: ids.ios_bundle_id }).catch(() => null))?.sellerName || null;
        }
      } else if (!stores().googlePlay.configured) {
        result = { status: 'unreachable', roleFound: '', roleNeeded: needed };
      } else if (ids.android_package) {
        result = await stores().googlePlay.checkAccess({ packageName: ids.android_package });
        if (result.status === 'ok') sellerName = (await stores().googlePlay.trackState({ packageName: ids.android_package }).catch(() => null))?.sellerName || null;
      }
    } catch {
      result = { status: 'unreachable', roleFound: '', roleNeeded: needed };
    }
    const status = ['ok', 'role_too_low', 'invalid', 'unreachable'].includes(result.status) ? result.status : 'unreachable';
    const sellerMatches = sellerName === null ? null : Boolean(row.legal_name) && sameName(sellerName, row.legal_name);
    const actorId = actorOf(user);
    const saved = await db.tx(async (t) => {
      await t.query('INSERT INTO store_access (tenant_id, platform) VALUES ($1, $2) ON CONFLICT (tenant_id, platform) DO NOTHING', [tenantId(), platform]);
      const [updated] = await t.query(
        `UPDATE store_access SET access_status = $3, role_found = $4, role_needed = $5, checked_at = now(),
           credential_kind = CASE WHEN platform = 'android' AND $3 = 'ok' THEN 'play_service_account' ELSE credential_kind END, updated_at = now()
         WHERE tenant_id = $1 AND platform = $2 RETURNING *`,
        [tenantId(), platform, status, String(result.roleFound ?? '').slice(0, 60), String(result.roleNeeded || needed).slice(0, 60)],
      );
      await writeAudit(t, { actor: actorId ? `user:${actorId}` : 'system', action: CHECKED, target: `store_access:${platform}`, details: { platform, status, sellerMatches } });
      return updated;
    });
    log.info('store_access.checked', { tenantId: tenantId(), platform, status });
    return view(saved, { sellerMatches, sellerName });
  }

  /**
   * What a store submit needs, for this business only: { kind: 'asc_api_key', keyId, issuerId, privateKey } on iOS, our service
   * account on Android, or null. Called by app-submissions' submit() and nowhere else; never answered, logged or stored again.
   */
  async function credentials(platform) {
    if (platform === 'ios') {
      const key = openKey(await rowOf('ios'));
      return key ? { kind: 'asc_api_key', ...key } : null;
    }
    if (platform === 'android') {
      const ids = await appIds();
      if (!stores()?.googlePlay?.configured || !config.playServiceAccount || !ids.android_package) return null;
      return { kind: 'play_service_account', packageName: ids.android_package, serviceAccount: String(config.playServiceAccount) };
    }
    return null;
  }

  /** The store's reader for this business's app on `platform`, or null: what the review poll asks. */
  async function reviewReader(platform) {
    const ids = await appIds();
    if (platform === 'ios') {
      const key = openKey(await rowOf('ios'));
      if (!key || !ids.ios_bundle_id) return null;
      const asc = stores().appStoreConnect.forKey(key);
      return async () => {
        const state = await asc.reviewState({ bundleId: ids.ios_bundle_id });
        return { state: state.state, version: state.version, buildNumber: state.buildNumber, storeUrl: state.storeUrl, rejection: state.rejection, source: 'appstore' };
      };
    }
    if (!stores()?.googlePlay?.configured || !ids.android_package) return null;
    return async () => {
      const state = await stores().googlePlay.trackState({ packageName: ids.android_package });
      return { state: state.state, version: state.versionName, buildNumber: state.versionCode, storeUrl: state.storeUrl, rejection: state.rejection, source: 'play' };
    };
  }

  return { list, get, save, check, credentials, reviewReader, requireApp };
}
