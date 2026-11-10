import { z } from 'zod';
import { PERMISSIONS, PUBLIC, SIGNED_IN } from './access.js';
import { Id } from './common.js';

/**
 * Bad input here is treated as a wrong password rather than a validation error, so a login attempt
 * learns nothing about which part was wrong. `transport` picks how the session travels: the owner app
 * keeps a bearer token; the web console uses an httpOnly cookie plus the returned CSRF token.
 */
export const LoginBody = z.object({
  phone: z.string().max(20).catch(''),
  password: z.string().max(200).catch(''),
  transport: z.enum(['bearer', 'cookie']).catch('bearer'),
});

export const SessionUser = z.object({
  id: Id,
  name: z.string(),
  phone: z.string(),
  role: z.enum(['owner', 'manager', 'staff', 'customer']),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
});

export const SessionBusiness = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  plan: z.string(),
  logoUrl: z.string().default(''),
});

/** `csrf` is present on cookie sessions: send it back as the x-csrf-token header on every change. */
export const CurrentSession = z.object({ user: SessionUser, business: SessionBusiness, csrf: z.string().optional() });

/** `token` and `expiresInDays` are present for transport "bearer". */
export const LoginResult = CurrentSession.extend({ token: z.string().optional(), expiresInDays: z.number().int().optional() });

export const authRoutes = {
  'auth.login': { method: 'POST', path: '/auth/login', access: PUBLIC, body: LoginBody, status: 201, response: LoginResult },
  'auth.me': { method: 'GET', path: '/auth/me', access: SIGNED_IN, response: CurrentSession },
  'auth.logout': { method: 'POST', path: '/auth/logout', access: SIGNED_IN, status: 204, response: null },
};
