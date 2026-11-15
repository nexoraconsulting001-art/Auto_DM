-- Phase 8: what a business said in a showcase session, and what became of it (Q-13). Kept by Bhava's team in the Platform
-- Console; a business has no access to it at all (the fence, and no grant to the app role).
CREATE TABLE feedback_items (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  said_by    text NOT NULL CHECK (length(btrim(said_by)) BETWEEN 1 AND 120),           -- who said it: a name or a role
  area       text NOT NULL CHECK (length(btrim(area)) BETWEEN 1 AND 80),               -- where in the product
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  severity   text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'blocker')),
  state      text NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'planned', 'fixed', 'declined')),
  fixed_in   text NOT NULL DEFAULT '' CHECK (length(fixed_in) <= 80),                  -- the commit or release that fixed it
  created_by integer REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((state = 'fixed') = (fixed_in <> ''))
);
CREATE INDEX feedback_items_tenant_idx ON feedback_items (tenant_id, id DESC);
CREATE INDEX feedback_items_state_idx ON feedback_items (state, id DESC);
CREATE INDEX feedback_items_created_by_idx ON feedback_items (created_by);
ALTER TABLE feedback_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON feedback_items USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
