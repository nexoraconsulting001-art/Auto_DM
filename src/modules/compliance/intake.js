import crypto from 'node:crypto';
import { verifyHubSignature } from '../../adapters/meta/index.js';
import { PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { log } from '../../platform/log.js';
import { baseUrlFor } from '../admin-api/urls.js';

function sameText(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The webhook's two routes (PRD 4.1). Registered in beforeTenant, so they replace the Phase 0 routes in src/server.js. A delivery
 * is stored before the 200 goes back; if it can't be stored the answer is a 500, and Meta sends it again.
 */
export function registerIntake(app, { config, compliance }) {
  const path = PROVIDER_PATHS.webhook;

  app.get(path, (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && config.verifyToken && typeof token === 'string' && sameText(token, config.verifyToken) && typeof challenge === 'string') {
      return res.status(200).type('text/plain').send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post(path, async (req, res, next) => {
    const signature = req.get('x-hub-signature-256');
    // No signature at all can't be Meta. It goes on to whatever else answers this path, which ends in the same 401.
    if (signature === undefined) return next();
    const secrets = [config.appSecret, config.fbAppSecret].filter(Boolean);
    if (!secrets.some((secret) => verifyHubSignature(req.rawBody, signature, secret))) {
      log.warn('webhook.bad_signature', { reason: 'webhook.bad_signature' });
      return res.sendStatus(401);
    }
    await compliance.storeDelivery(req.body, { base: baseUrlFor(req, config) });
    res.sendStatus(200);
    await compliance.poke();
    return undefined;
  });

  // A body that isn't JSON fails in the parser, before the signature can be checked. It is the client's mistake and not a fault of ours.
  app.use(path, (err, req, res, next) => {
    if (err?.status >= 400 && err?.status < 500) {
      log.warn('webhook.malformed', { reason: 'webhook.malformed', status: err.status });
      return res.sendStatus(err.status === 413 ? 413 : 400);
    }
    return next(err);
  });
}

