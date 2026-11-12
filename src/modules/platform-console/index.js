import path from 'node:path';
import express from 'express';
import { createPlatformAuth, requirePlatformRole, sameOriginOnly } from '../../auth.js';
import { PLATFORM_ROLES } from '../../contracts/api/access.js';
import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { reportError } from '../../platform/log.js';
import { platformNotBuilt } from '../not-built.js';
import { normalizeHost } from '../../tenancy.js';
import { registerBusinessRoutes } from './businesses.js';
import { platformHostOf } from './host.js';
import { sweepRawExports } from './raw-export.js';
import { platformUsersRepo } from './repo.js';

export { platformHostOf };

const HOUR = 3_600_000;
const ANSWERED_HERE = ['platform.me', 'platform.signOut'];
const NOT_BUILT = OPS_PLATFORM_OWNERS['platform-console'].filter((id) => !ANSWERED_HERE.includes(id));

const describe = (user) => ({ id: user.id, email: user.email, name: user.name, role: user.role });

const CONTENT_SECURITY_POLICY = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "connect-src 'self'", "img-src 'self' https: data:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
const SHELL_HEADERS = { 'Cache-Control': 'no-store', 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };

/**
 * The Platform Console's web app: console/dist-platform, the second entry of the console project (console/platform.html),
 * at /console. Mounted inside the platform host's router only, so no business address ever serves a file of it; the
 * seller console's own build (console/dist) holds none of it either. The page holds no data: everything comes from the
 * routes below, which check the role on every call. Any path that is not a file is a page of the app.
 */
function consoleApp(config) {
  const root = config.platformConsoleDir;
  const r = express.Router();
  r.use('/assets', express.static(path.join(root, 'assets'), { index: false, redirect: false, immutable: true, maxAge: '1y' }));
  r.use(express.static(root, { index: false, redirect: false, maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('.html')) res.set(SHELL_HEADERS); } }));
  r.get(/.*/, (req, res) => {
    if (path.extname(req.path)) return res.status(404).type('text').send('Not found.');
    res.sendFile('platform.html', { root, cacheControl: false, headers: SHELL_HEADERS }, (err) => {
      if (!err || res.headersSent) return;
      res.status(503).type('text').send('The console isn’t available right now.');
    });
  });
  return r;
}

/**
 * The Platform Console's sign-in, on its own host. This host never reaches a business: it is matched before
 * any business is looked up and everything unmatched ends here. Other modules add console pages with a
 * platformRoutes(router, ctx) hook and guard them with requirePlatformRole.
 */
export const platformConsole = {
  name: 'platform-console',
  repos: (db) => ({ platformUsers: platformUsersRepo(db) }),

  beforeTenant(app, ctx) {
    const host = platformHostOf(ctx.config);
    if (!host) return; // No platform host configured: platform sign-in is off.
    const { repos, config, platform, modules } = ctx;
    const auth = createPlatformAuth({ secret: config.sessionSecret, platformUsers: repos.platformUsers, cache: platform.cache });
    const r = express.Router();
    r.use(auth.load, auth.checkCsrf);

    // The Phase 0 email and password sign-in, kept only behind PASSWORD_LOGIN (tests and local work). The console signs in
    // with an emailed code plus TOTP: platform.signInStart, signInVerify and signInTotp (PRD 5.5).
    r.post('/login', sameOriginOnly, async (req, res) => {
      if (!config.passwordLogin) return res.status(404).type('text').send('Not found.');
      if (await auth.tooManyAttempts(req)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
      const user = await repos.platformUsers.verify(String(req.body?.email ?? '').slice(0, 200), req.body?.password);
      if (!user) {
        await auth.recordFailure(req);
        return res.status(401).json({ error: 'That email and password don’t match.' });
      }
      const csrf = await auth.login(req, res, user);
      res.json({ user: describe(user), csrf });
    });

    r.post('/logout', requirePlatformRole(...PLATFORM_ROLES), async (req, res) => {
      await auth.logout(req, res);
      res.sendStatus(204);
    });

    r.get('/me', requirePlatformRole(...PLATFORM_ROLES), (req, res) => res.json({ user: describe(req.platformUser), csrf: req.platformCsrf }));

    r.use('/console', consoleApp(config));
    r.get('/', (_req, res) => res.redirect(302, '/console/'));

    for (const m of modules) m.platformRoutes?.(r, { ...ctx, platformAuth: auth });
    r.use((_req, res) => res.status(404).type('text').send('Not found.'));

    app.use((req, res, next) => (normalizeHost(req.hostname) === host ? r(req, res, next) : next()));
  },

  platformRoutes(router, ctx) {
    registerBusinessRoutes(router, ctx);
    // platform.me and platform.signOut are answered above, before any module's routes.
    platformNotBuilt(router, ...NOT_BUILT);
  },

  jobs({ db, platform }) {
    let nextSweep = 0;
    return async function schedule() {
      if (Date.now() < nextSweep) return;
      nextSweep = Date.now() + HOUR;
      await sweepRawExports({ db, storage: platform.storage }).catch((err) => reportError(err, { msg: 'raw_export.sweep_failed' }));
    };
  },
};
