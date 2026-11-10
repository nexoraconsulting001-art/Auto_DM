-- Phase 0: the manager role, staff permissions and one person working at several businesses (PRD 5.2, 5.11).

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'manager', 'staff', 'customer'));

-- Only staff use this. It must match PERMISSIONS in src/contracts/api/access.js.
ALTER TABLE users ADD COLUMN permissions text[] NOT NULL DEFAULT '{}'
  CHECK (permissions <@ ARRAY['catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox']);

-- Sign-in looks across businesses for the same person's other accounts, and only sellers have any.
CREATE INDEX users_seller_phone_idx ON users (phone) WHERE role IN ('owner', 'manager', 'staff');

-- "The person signed in as this user may also work as that user at that business." Written in pairs, only
-- when the person has proved both accounts are theirs: a phone number on an account proves nothing by itself.
CREATE TABLE memberships (
  tenant_id        integer NOT NULL,
  user_id          integer NOT NULL,
  member_tenant_id integer NOT NULL,
  member_user_id   integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, member_tenant_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (member_tenant_id, member_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX memberships_member_idx ON memberships (member_tenant_id, member_user_id);

-- Only platform code writes these, because a pair spans two businesses.
SELECT fence_tenant_table('memberships', 'SELECT');
