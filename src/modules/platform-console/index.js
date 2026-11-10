import express from 'express';
import { createPlatformAuth, requirePlatformRole, sameOriginOnly } from '../../auth.js';
import { reportError } from '../../platform/log.js';
import { normalizeHost } from '../../tenancy.js';
import { registerBusinessRoutes } from './businesses.js';
import { platformHostOf } from './host.js';
import { sweepRawExports } from './raw-export.js';
import { platformUsersRepo } from './repo.js';

export { platformHostOf };

const HOUR = 3_600_000;

const describe = (user) => ({ id: user.id, email: user.email, name: user.name, role: user.role });

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

    r.post('/login', sameOriginOnly, async (req, res) => {
      if (await auth.tooManyAttempts(req)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
      const user = await repos.platformUsers.verify(String(req.body?.email ?? '').slice(0, 200), req.body?.password);
      if (!user) {
        await auth.recordFailure(req);
        return res.status(401).json({ error: 'That email and password don’t match.' });
      }
      const csrf = await auth.login(req, res, user);
      res.json({ user: describe(user), csrf });
    });

    r.post('/logout', requirePlatformRole('super_admin', 'support'), async (req, res) => {
      await auth.logout(req, res);
      res.sendStatus(204);
    });

    r.get('/me', requirePlatformRole('super_admin', 'support'), (req, res) => res.json({ user: describe(req.platformUser), csrf: req.platformCsrf }));

    for (const m of modules) m.platformRoutes?.(r, { ...ctx, platformAuth: auth });
    r.use((_req, res) => res.status(404).type('text').send('Not found.'));

    app.use((req, res, next) => (normalizeHost(req.hostname) === host ? r(req, res, next) : next()));
  },

  platformRoutes: registerBusinessRoutes,

  jobs({ db, platform }) {
    let nextSweep = 0;
    return async function schedule() {
      if (Date.now() < nextSweep) return;
      nextSweep = Date.now() + HOUR;
      await sweepRawExports({ db, storage: platform.storage }).catch((err) => reportError(err, { msg: 'raw_export.sweep_failed' }));
    };
  },
};
