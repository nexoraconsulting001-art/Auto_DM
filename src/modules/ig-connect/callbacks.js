import crypto from 'node:crypto';
import { verifySignedRequest } from '../../adapters/meta/index.js';
import { DeletionStatus, PROVIDER_PATHS, SignedRequestBody, SignedRequestPayload } from '../../contracts/api/provider.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { HEALTH_PROBE } from './gates.js';
import { deletionStatusPage } from './pages.js';

const CODE = /^[a-f0-9]{32}$/;

/**
 * What Meta calls when someone removes the app or asks for their data to be deleted (PRD 4.2, 4.14). Both arrive with a signed_request and no
 * business, so the account id finds the business through db.platform. Anything not signed by a Meta app of ours gets a 400 and changes nothing.
 */
export function createCallbacks({ db, repos, config, gates }) {
  const platformDb = db.platform;
  const appSecrets = () => [config.appSecret, config.fbAppSecret].filter(Boolean);

  function verified(body) {
    const parsed = SignedRequestBody.safeParse(body ?? {});
    if (!parsed.success) return null;
    for (const secret of appSecrets()) {
      const payload = SignedRequestPayload.safeParse(verifySignedRequest(parsed.data.signed_request, secret));
      if (payload.success) return payload.data;
    }
    return null;
  }

  function refuse(req, res, route) {
    if (req.body?.signed_request !== HEALTH_PROBE) log.warn('meta.callback_bad_signature', { route });
    res.status(400).json({ error: 'Invalid request' });
  }

  /** Meta's id for who is asking may be the account id webhooks carry or its app-scoped id (PRD 4.3 row 21: to confirm). */
  async function findAccount(userId) {
    const [row] = await platformDb.query(
      `SELECT ig_user_id, tenant_id FROM ig_accounts WHERE ig_user_id = $1 OR (app_scoped_id <> '' AND app_scoped_id = $1) ORDER BY (ig_user_id = $1) DESC LIMIT 1`,
      [userId],
    );
    return row ?? null;
  }

  const reEvaluateGates = () => gates.evaluate().catch((err) => reportError(err, { msg: 'ig_connect.gates_failed' }));

  async function deauthorize(req, res) {
    const payload = verified(req.body);
    if (!payload) return refuse(req, res, 'deauthorize');
    const account = await findAccount(payload.user_id);
    if (!account) {
      log.warn('meta.deauthorize_unknown_account', { accountId: payload.user_id });
      return res.json({ success: true });
    }
    await withTenant(account.tenant_id, async () => {
      const changed = await repos.igAccounts.loseToken(account.ig_user_id, 'token.deauthorized', { actor: 'meta:deauthorize' });
      if (changed) await reEvaluateGates();
    });
    res.json({ success: true });
  }

  /** The request stays open until the data is gone, so a repeat from Meta gets the same code. */
  async function openDeletionRequest(account, userId) {
    const accountId = account?.ig_user_id ?? String(userId);
    const [open] = await platformDb.query(
      `SELECT * FROM data_deletion_requests WHERE channel = 'instagram' AND account_id = $1 AND status = 'requested' ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    if (open) return open;
    const [created] = await platformDb.query(
      `INSERT INTO data_deletion_requests (confirmation_code, tenant_id, channel, account_id) VALUES ($1, $2, 'instagram', $3) RETURNING *`,
      [crypto.randomBytes(16).toString('hex'), account?.tenant_id ?? null, accountId],
    );
    return created;
  }

  /** Removes the account's data and closes the request. Safe to run again. With no business behind the account, there is nothing to remove. */
  async function completeDeletion(request) {
    if (request.tenant_id) {
      await withTenant(request.tenant_id, async () => {
        await repos.igAccounts.eraseAccount(request.account_id);
        await reEvaluateGates();
      });
    }
    await platformDb.query(`UPDATE data_deletion_requests SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'requested'`, [request.id]);
  }

  const statusUrl = (req, code) => `${config.metaCallbackBaseUrl || config.publicBaseUrl || `${req.protocol}://${req.get('host')}`}${PROVIDER_PATHS.deletion}/${code}`;

  async function deletion(req, res) {
    const payload = verified(req.body);
    if (!payload) return refuse(req, res, 'deletion');
    const account = await findAccount(payload.user_id);
    const request = await openDeletionRequest(account, payload.user_id);
    if (account) await withTenant(account.tenant_id, () => repos.igAccounts.stopForDeletion(account.ig_user_id));
    res.json({ url: statusUrl(req, request.confirmation_code), confirmation_code: request.confirmation_code });
    // After the answer, so a large account can't make Meta wait. The sweep finishes anything this doesn't.
    completeDeletion(request).catch((err) => reportError(err, { msg: 'meta.deletion_failed', request: Number(request.id) }));
  }

  async function deletionStatus(req, res) {
    const [row] = CODE.test(req.params.code)
      ? await platformDb.query('SELECT status, requested_at, completed_at FROM data_deletion_requests WHERE confirmation_code = $1', [req.params.code])
      : [];
    res.set('Cache-Control', 'no-store');
    if (!row) return res.status(404).json({ error: 'Not found' });
    const answer = DeletionStatus.parse({ status: row.status, requestedAt: row.requested_at, completedAt: row.completed_at });
    if (req.accepts(['json', 'html']) === 'html') return res.type('html').send(String(deletionStatusPage(answer)));
    res.json(answer);
  }

  /** Finishes requests the web process didn't, for the 30-day promise in PRD 4.14. */
  async function finishOpenDeletions(limit = 50) {
    const open = await platformDb.query(`SELECT * FROM data_deletion_requests WHERE status = 'requested' ORDER BY requested_at LIMIT $1`, [limit]);
    for (const request of open) {
      await completeDeletion(request).catch((err) => reportError(err, { msg: 'meta.deletion_failed', request: Number(request.id) }));
    }
    return open.length;
  }

  return { deauthorize, deletion, deletionStatus, finishOpenDeletions };
}
