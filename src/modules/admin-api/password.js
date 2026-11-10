import { z } from 'zod';
import { ApiError, SIGNED_IN, isAllowed } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { normalizePhone } from '../../util.js';

export const PASSWORD_CHANGE_PATH = '/api/v1/auth/password';

const BEARER_SESSION_DAYS = 30;
const MIN_LENGTH_MESSAGE = 'Use a password of at least 6 characters';

// 200 is the longest password auth.login reads, so nobody can set one they could never log in with.
const PasswordChange = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: z.string().min(6, MIN_LENGTH_MESSAGE).max(200, 'Use 200 characters or fewer'),
});

const PasswordChanged = z.object({ csrf: z.string().optional(), token: z.string().optional(), expiresInDays: z.number().int().optional() });

function parsed(body) {
  const result = PasswordChange.safeParse(body ?? {});
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  const messages = Object.values(fields);
  throw new ApiError('validation_failed', messages.length === 1 ? messages[0] : 'Please check the highlighted details.', { fields });
}

/**
 * POST /api/v1/auth/password. The contract in src/contracts/api has no route for this yet, so it is mounted
 * here directly, with the same checks the router applies. It has to be registered before the api-v1 router,
 * whose catch-all answers every /api/v1 path nobody has taken.
 */
export function mountPasswordChange(app, { repos, auth, config }) {
  // ensureOwner resets the .env owner's password on every start, so a change here would not last.
  const isEnvOwner = (user) => user.role === 'owner' && Boolean(config.adminPhone) && user.phone === normalizePhone(config.adminPhone);

  app.post(PASSWORD_CHANGE_PATH, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAllowed(req.user ?? null, SIGNED_IN)) throw new ApiError('unauthorized');
    if (!req.is('application/json')) throw new ApiError('unsupported_media_type', 'Send this as JSON.');
    const { currentPassword, newPassword } = parsed(req.body);

    if (isEnvOwner(req.user)) throw new ApiError('conflict', 'The owner password is set in .env (ADMIN_PASSWORD).');
    if (await auth.tooManyAttempts(req)) throw new ApiError('rate_limited', 'Too many tries. Wait 15 minutes and try again.');
    if (!(await repos.users.verify(req.user.phone, currentPassword))) {
      await auth.recordFailure(req);
      // Not a 401: this session is fine, and the clients sign the person out on any 401.
      const message = 'Your current password isn’t right.';
      throw new ApiError('validation_failed', message, { fields: { currentPassword: message } });
    }

    await repos.users.setPassword(req.user.id, newPassword);
    log.info('auth.password_changed', { userId: req.user.id });

    // The change ended every session, this one included. The person who made it stays signed in here.
    if (req.bearer) {
      await auth.clearFailures(req);
      const token = await repos.sessions.create(req.user.id, BEARER_SESSION_DAYS, 'bearer');
      return res.json(PasswordChanged.parse({ token, expiresInDays: BEARER_SESSION_DAYS }));
    }
    res.json(PasswordChanged.parse({ csrf: await auth.login(req, res, req.user) }));
  });
}
