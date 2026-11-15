-- Phase 8: importing an old single-shop app into one business (PRD 5.16). Both tables are the platform's: a business has
-- no access to them at all (row-level security with the fence, and no grant to the app role), like customisation_requests.

-- One row per dry run or real run of the importer. `source` is a label for the export, `source_hash` the sha-256 of its
-- contents: a real run that finished is never repeated for the same export into the same business.
CREATE TABLE migration_runs (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 200),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  mode        text NOT NULL CHECK (mode IN ('dry', 'real')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  -- { "<table>": { "source": n, "imported": n, "skipped": n } }: numbers only.
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  -- [{ "kind", "table", "oldId", "blocking" }]: ids and codes only, never a username or a message.
  conflicts   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conflicts) = 'array'),
  error       text NOT NULL DEFAULT '' CHECK (length(error) <= 500),
  started_by  integer REFERENCES platform_users(id) ON DELETE SET NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX migration_runs_once_idx ON migration_runs (tenant_id, source_hash) WHERE mode = 'real' AND status = 'done';
CREATE INDEX migration_runs_tenant_idx ON migration_runs (tenant_id, id DESC);
CREATE INDEX migration_runs_started_by_idx ON migration_runs (started_by);
ALTER TABLE migration_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON migration_runs USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Which new row each old row became. One row per old id per business, whichever run made it, so a second run finds what
-- the first one imported and writes nothing twice. Ids are kept as text: the old app's ids are numbers or strings.
CREATE TABLE migration_id_map (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id     bigint NOT NULL,
  table_name text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  old_id     text NOT NULL CHECK (length(old_id) BETWEEN 1 AND 200),
  new_id     text NOT NULL CHECK (length(new_id) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, table_name, old_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES migration_runs(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX migration_id_map_run_idx ON migration_id_map (tenant_id, run_id);
ALTER TABLE migration_id_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON migration_id_map USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
