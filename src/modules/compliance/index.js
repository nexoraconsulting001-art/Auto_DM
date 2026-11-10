import { reportError } from '../../platform/log.js';
import { complianceApi } from './api.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { registerIntake } from './intake.js';
import { complianceRepo } from './repo.js';

import { DRAIN_QUEUE, markWorkerRunning } from './send.js';

export { createCompliance } from './send.js';

/** Pages a buyer opens, which "pause store" closes. /admin, the API, sign-in and webhooks stay up, so the seller can always lift it. */
const buyerPage = (path) => !/^\/(admin|api|login|logout|signup|account|static|media|webhook|health|healthz|readyz|metrics|oauth|meta|tls)(\/|$)/.test(path);

function storePause({ compliance, repos }) {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !buyerPage(req.path)) return next();
    const { pauseStore, tenantPaused } = await compliance.gate.switches('instagram');
    if (!pauseStore || !tenantPaused) return next();
    const settings = await repos.settings.getAll();
    return res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Back soon</title><body style="font-family:system-ui;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center"><main><h1>${escapeHtml(settings.store_name)}</h1><p>We’re taking a short break and will be back soon.</p></main></body>`);
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * PRD 4, 6.1 to 6.4: the gate every send passes, webhook intake, the queue and its worker, budgets, caps, opt-outs, the
 * breaker and the kill switch. Intake registers POST /webhook in beforeTenant, which runs before the Phase 0 route in
 * src/server.js and so replaces it.
 *
 * A module that answers inbound events either has onInboundEvent(event, ctx), or calls ctx.compliance.onInbound(fn). See inbound.js.
 */
export const compliance = {
  name: 'compliance',
  repos: (db) => ({ compliance: complianceRepo(db) }),

  beforeTenant(app, ctx) {
    subscribe(ctx.compliance, ctx.modules, ctx);
    registerIntake(app, ctx);
  },

  routes(app, ctx) {
    app.use(storePause(ctx));
  },

  platformRoutes(router, ctx) {
    registerPlatformRoutes(router, ctx);
  },

  api: (ctx) => complianceApi(ctx),

  /** One short job at a time on the platform queue: intake pokes it, a turn wakes the next one, and schedule() is the safety net every minute. */
  jobs(ctx) {
    const { compliance: engine, platform } = ctx;
    // This module is in that list, so it can't be imported at the top of the file.
    import('../index.js').then(({ MODULES }) => subscribe(engine, MODULES, ctx)).catch((err) => reportError(err, { msg: 'compliance.subscribe_failed' }));
    markWorkerRunning();
    platform.queue.work(DRAIN_QUEUE, () => engine.workOnce());
    return async function schedule() {
      await engine.maintain();
      if (await engine.hasWork()) await engine.poke();
    };
  },
};

function subscribe(engine, modules, ctx) {
  for (const module of modules) {
    if (typeof module.onInboundEvent === 'function') engine.onInbound((event) => module.onInboundEvent(event, ctx));
  }
}
