-- Phase 5 (PRD 5.11): inviting someone to a business's team. A tenant table, following the tenant pattern.
-- The invited phone or email is stored only as a hash: the invitation is taken up when a person signs in with a
-- verified identity that hashes to the same value, or opens the link that carries the token.

CREATE TABLE team_invites (
  id               serial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_kind     text NOT NULL CHECK (contact_kind IN ('phone', 'email')),
  contact_hash     text NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  -- Must match PERMISSIONS in src/contracts/api/access.js. Only staff carry any.
  permissions      text[] NOT NULL DEFAULT '{}' CHECK (permissions <@ ARRAY['catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox']),
  token_hash       text NOT NULL UNIQUE,
  invited_by       integer NOT NULL,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id integer,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, accepted_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CHECK (role = 'staff' OR permissions = '{}'),
  CHECK (accepted_user_id IS NULL OR accepted_at IS NOT NULL)
);
-- One open invitation per contact per business.
CREATE UNIQUE INDEX team_invites_open_idx ON team_invites (tenant_id, contact_kind, contact_hash) WHERE accepted_at IS NULL AND revoked_at IS NULL;
SELECT fence_tenant_table('team_invites');
