import express from 'express';
import { currentTenant } from '../../tenancy.js';

const SESSION_DAYS = 30;

const describe = (user) => {
  const t = currentTenant();
  return {
    user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
    business: { id: t.id, slug: t.slug, name: t.name, plan: t.plan },
  };
};

/**
 * Bearer sessions for the API and the mobile app. Logging in happens on the business's own address, which
 * is how the business is known at that moment; after that the token alone says who and which business.
 */
export const apiAuth = {
  name: 'api-auth',
  routes(app, { repos, auth }) {
    const r = express.Router();

    r.post('/login', async (req, res) => {
      if (await auth.tooManyAttempts(req)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
      const user = await repos.users.verify(String(req.body?.phone ?? '').slice(0, 20), req.body?.password);
      if (!user) {
        await auth.recordFailure(req);
        return res.status(401).json({ error: 'That mobile number and password don’t match.' });
      }
      await auth.clearFailures(req);
      const token = await repos.sessions.create(user.id, SESSION_DAYS, 'bearer');
      res.status(201).json({ token, expiresInDays: SESSION_DAYS, ...describe(user) });
    });

    r.get('/me', (req, res) => {
      if (!req.user) return res.status(401).json({ error: 'Please log in again.' });
      res.json(describe(req.user));
    });

    r.post('/logout', async (req, res) => {
      if (!req.bearer) return res.status(401).json({ error: 'Please log in again.' });
      await repos.sessions.revoke(req.sessionToken);
      res.sendStatus(204);
    });

    app.use('/api/v1/auth', r);
  },
};
