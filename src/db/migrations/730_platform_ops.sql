-- Phase 7: the Platform Console's remaining work (PRD 5.6, 5.8, 5.9, 5.10, 5.17): console sign-in, impersonation, managed
-- services, done-for-you onboarding and the health console. Every table that names a business has tenant_id and the fence.

-- ---- Console sign-in (5.5): an emailed code plus TOTP ----

-- 107 already gave platform_users totp_secret_enc (encrypted by the secrets module) and totp_enrolled_at (set when the first
-- code from the authenticator is confirmed), and created platform_login_codes. What was missing: the roles and recovery codes.
ALTER TABLE platform_users DROP CONSTRAINT platform_users_role_check;
ALTER TABLE platform_users ADD CONSTRAINT platform_users_role_check CHECK (role IN ('super_admin', 'support', 'onboarding', 'service_operator'));
ALTER TABLE platform_users ALTER COLUMN password_hash SET DEFAULT '';
ALTER TABLE platform_users ADD COLUMN disabled_at timestamptz;

-- One-time codes for a lost authenticator. Only a hash is stored; a used code stays, spent.
CREATE TABLE platform_recovery_codes (
  id               bigserial PRIMARY KEY,
  platform_user_id integer NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  code_hash        text NOT NULL CHECK (length(code_hash) BETWEEN 20 AND 100),
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_user_id, code_hash)
);

-- ---- Impersonation (5.10) ----

-- One row per time an operator opens a business as its owner. At most 30 minutes, held here and not in code. `mode` starts
-- as read; write needs the second confirmation, which stamps write_confirmed_at. Business code reads it (the API router
-- checks it on every request); only the platform writes it.
CREATE TABLE impersonation_sessions (
  id                 bigserial PRIMARY KEY,
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operator_id        integer NOT NULL REFERENCES platform_users(id),
  -- The name the banner shows, copied when the session starts: business code cannot read platform_users.
  operator_name      text NOT NULL DEFAULT '' CHECK (length(operator_name) <= 80),
  owner_user_id      integer NOT NULL,
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  mode               text NOT NULL DEFAULT 'read' CHECK (mode IN ('read', 'write')),
  write_confirmed_at timestamptz,
  started_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  ended_at           timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '30 minutes'),
  CHECK ((mode = 'write') = (write_confirmed_at IS NOT NULL))
);
CREATE INDEX impersonation_sessions_operator_idx ON impersonation_sessions (operator_id, started_at DESC);
SELECT fence_tenant_table('impersonation_sessions', 'SELECT');

-- ---- Managed services (5.17) ----

-- Which paid service a business has, from when to when, and whether the team's changes go live or wait for the seller.
-- One row per service: a service bought again moves active_from and clears active_to. The seller may change `mode` only.
CREATE TABLE service_engagements (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service     text NOT NULL CHECK (service IN ('reel_management', 'reel_backlog', 'merchandising', 'catalog_management', 'performance_report')),
  mode        text NOT NULL DEFAULT 'direct' CHECK (mode IN ('direct', 'approve_first')),
  active_from timestamptz NOT NULL DEFAULT now(),
  active_to   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, service),
  CHECK (active_to IS NULL OR active_to >= active_from)
);
SELECT fence_tenant_table('service_engagements', 'SELECT');
GRANT UPDATE (mode, updated_at) ON service_engagements TO bhava_app;

-- One sitting of an operator's work for one service. No session without a task reference.
CREATE TABLE service_sessions (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operator_id integer NOT NULL REFERENCES platform_users(id),
  operator_name text NOT NULL DEFAULT '' CHECK (length(operator_name) <= 80),
  service     text NOT NULL,
  task_ref    text NOT NULL CHECK (length(btrim(task_ref)) BETWEEN 1 AND 120),
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '8 hours',
  ended_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service) REFERENCES service_engagements(tenant_id, service),
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '8 hours')
);
CREATE INDEX service_sessions_operator_idx ON service_sessions (operator_id, started_at DESC);
SELECT fence_tenant_table('service_sessions', 'SELECT');

-- Every write an operator made, or asked to make: the route, what it changed, and that thing before and after, with secrets
-- masked before they reach this table. `request` is what was sent (path values and body), kept so a draft can be applied
-- and a change undone through the same route. applied -> undone; draft -> approved or rejected; approved -> undone.
CREATE TABLE service_changes (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  bigint NOT NULL,
  service     text NOT NULL,
  operator_id integer NOT NULL REFERENCES platform_users(id),
  task_ref    text NOT NULL CHECK (length(task_ref) BETWEEN 1 AND 120),
  route_id    text NOT NULL CHECK (length(route_id) BETWEEN 3 AND 80),
  target      text NOT NULL DEFAULT '' CHECK (length(target) <= 200),
  request     jsonb NOT NULL DEFAULT '{}',
  before      jsonb,
  after       jsonb,
  state       text NOT NULL CHECK (state IN ('applied', 'draft', 'approved', 'rejected', 'undone')),
  decided_by  text NOT NULL DEFAULT '' CHECK (length(decided_by) <= 80),
  decided_at  timestamptz,
  undone_by   text NOT NULL DEFAULT '' CHECK (length(undone_by) <= 80),
  undone_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES service_sessions(tenant_id, id),
  CHECK ((state = 'undone') = (undone_at IS NOT NULL)),
  CHECK (state = 'undone' OR undone_by = ''),
  CHECK (state NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL)
);
CREATE INDEX service_changes_feed_idx ON service_changes (tenant_id, created_at DESC, id DESC);
CREATE INDEX service_changes_month_idx ON service_changes (tenant_id, service, created_at);
SELECT fence_tenant_table('service_changes', 'SELECT, INSERT, UPDATE');

-- A seller session opened for an operator names what it was opened for. Either makes the API router treat every request
-- of that session by the rules of src/contracts/api/access.js. Ending the impersonation or the service session ends it.
ALTER TABLE sessions ADD COLUMN impersonation_id bigint;
ALTER TABLE sessions ADD COLUMN service_session_id bigint;
ALTER TABLE sessions ADD CONSTRAINT sessions_impersonation_fk FOREIGN KEY (tenant_id, impersonation_id) REFERENCES impersonation_sessions(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE sessions ADD CONSTRAINT sessions_service_session_fk FOREIGN KEY (tenant_id, service_session_id) REFERENCES service_sessions(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE sessions ADD CONSTRAINT sessions_one_operator CHECK (impersonation_id IS NULL OR service_session_id IS NULL);
ALTER TABLE sessions ADD CONSTRAINT sessions_operator_cookie CHECK ((impersonation_id IS NULL AND service_session_id IS NULL) OR kind = 'cookie');

-- ---- Done-for-you onboarding (5.6) ----

-- The owner's link. Only a hash of the token is stored; it works once and for at most 7 days; a business has one live
-- link at a time, so sending again means revoking the old one first. The platform's alone: fenced with no grant.
CREATE TABLE onboarding_invites (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) BETWEEN 20 AND 100),
  created_by integer REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  used_at    timestamptz,
  used_by    integer,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);
CREATE UNIQUE INDEX onboarding_invites_live_idx ON onboarding_invites (tenant_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- The checklist. Which steps a business has, and whether each is required, depends on its tier (src/contracts/onboarding.js);
-- the status is what the step's live check last found, never a box somebody ticked.
CREATE TABLE onboarding_steps (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step       text NOT NULL CHECK (step ~ '^[a-z][a-z_]{1,39}$'),
  required   boolean NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'waiting', 'done', 'failed')),
  checked_at timestamptz,
  detail     jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, step)
);
SELECT fence_tenant_table('onboarding_steps', 'SELECT, INSERT, UPDATE');

-- How long an operator was actively at work on each step (F-31): waits for the owner, Meta and DNS are not in it.
CREATE TABLE onboarding_timings (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operator_id integer NOT NULL REFERENCES platform_users(id),
  step        text NOT NULL CHECK (step ~ '^[a-z][a-z_]{1,39}$'),
  active_ms   integer NOT NULL CHECK (active_ms BETWEEN 0 AND 86400000),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL,
  CHECK (ended_at >= started_at)
);
CREATE INDEX onboarding_timings_tenant_idx ON onboarding_timings (tenant_id, started_at);

-- ---- Health (5.9) ----

-- The last answer of each check for each business (src/contracts/health.js). The platform writes it; the business reads it.
CREATE TABLE tenant_health_checks (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  check_name  text NOT NULL CHECK (check_name ~ '^[a-z][a-z0-9_.]{1,59}$'),
  status      text NOT NULL CHECK (status IN ('ok', 'warn', 'bad', 'unreachable')),
  last_ran_at timestamptz NOT NULL DEFAULT now(),
  detail      jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, check_name)
);
CREATE INDEX tenant_health_checks_status_idx ON tenant_health_checks (status, last_ran_at);
SELECT fence_tenant_table('tenant_health_checks', 'SELECT');

-- The platform's alone, though they name a business: the fence with no grant, as in 501.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['onboarding_invites', 'onboarding_timings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_fence ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', tbl);
  END LOOP;
END $$;
