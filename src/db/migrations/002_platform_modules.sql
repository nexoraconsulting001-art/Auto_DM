-- Phase 0, slice 2: the switchable modules' Postgres drivers.

-- Images move out of the database into the storage module; the row keeps the key.
-- (No Bhava data exists yet. Mehta Mart's old images are copied by the import script before the showcase.)
ALTER TABLE media DROP COLUMN data;
ALTER TABLE media ADD COLUMN storage_key text NOT NULL;

-- The job queue (QUEUE_DRIVER=pg). Production switches to Redis with the same interface.
CREATE TABLE jobs (
  id              bigserial PRIMARY KEY,
  queue           text NOT NULL,
  tenant_id       integer REFERENCES tenants(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'unknown')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  -- false: a job that was running when its worker died is marked 'unknown' and never run again
  -- (an Instagram DM may already have gone out). true: it is safe to run again.
  retry_in_flight boolean NOT NULL DEFAULT false,
  dedupe_key      text,
  run_at          timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  locked_by       text,
  last_error      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (queue, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_ready_idx ON jobs (queue, run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (lease_until) WHERE status = 'running';

-- Analytics events (ANALYTICS_DRIVER=pg). Production writes the same events to a separate analytics database.
CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  props      jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_tenant_name_idx ON events (tenant_id, name, at);
