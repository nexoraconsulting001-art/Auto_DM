-- Phase 1: what the owner or Bhava's team must be told (PRD 4.2, 4.10, 4.11, 4.12, 6.7, 6.10). Stored here at once, so the
-- 1 minute promise holds; email and push (PRD 5.13, 10.5) read from this table when they are built.
-- tenant_id is null for what is about no single business, which only ops can see.
CREATE TABLE alerts (
  id         bigserial PRIMARY KEY,
  tenant_id  integer REFERENCES tenants(id) ON DELETE CASCADE,
  audience   text NOT NULL DEFAULT 'owner' CHECK (audience IN ('owner', 'ops')),
  kind       text NOT NULL,
  severity   text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  message    text NOT NULL,
  target     text NOT NULL DEFAULT '',
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE UNIQUE INDEX alerts_dedupe_idx ON alerts (tenant_id, audience, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX alerts_list_idx ON alerts (tenant_id, audience, id DESC);
CREATE INDEX alerts_ops_idx ON alerts (audience, id DESC) WHERE audience = 'ops';
SELECT fence_tenant_table('alerts');
