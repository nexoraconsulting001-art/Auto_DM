-- Phase 0: business roles, and a separate table for Bhava's own team (PRD 2, 5.5, 5.11).

ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'owner' WHERE role = 'admin';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'staff', 'customer'));

-- Platform users are not business users: no tenant_id, and they sign in only on the platform host.
CREATE TABLE platform_users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('super_admin', 'support')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Only a hash of the token is stored, as with business sessions.
CREATE TABLE platform_sessions (
  id               text PRIMARY KEY,
  platform_user_id integer NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);
CREATE INDEX platform_sessions_user_idx ON platform_sessions (platform_user_id);
