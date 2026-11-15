-- Phase 9 (PRD 5.15): envelope encryption and master-key rotation.
--
-- The re-wrap job's place: one row per encrypted column (SECRET_COLUMNS in src/contracts/secrets.js) and target master
-- key. `last_id` is the last primary key finished (its parts joined by a comma, '' before the first step), so a job that
-- stops carries on where it was and two workers never redo a step. The platform's: no business reads it, and the app
-- role has no grant on it. It holds key ids and counts only, never a key or a value.
CREATE TABLE secret_rewraps (
  id          bigserial PRIMARY KEY,
  table_name  text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  column_name text NOT NULL CHECK (column_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  key_id      text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{8}$'),
  format      text NOT NULL DEFAULT 'v2' CHECK (format IN ('v1', 'v2')),
  last_id     text NOT NULL DEFAULT '' CHECK (length(last_id) <= 200),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  rows_done   bigint NOT NULL DEFAULT 0 CHECK (rows_done >= 0),
  failures    integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  started_at  timestamptz,
  finished_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_name, column_name, key_id, format),
  CHECK ((status = 'done') = (finished_at IS NOT NULL))
);
CREATE INDEX secret_rewraps_open_idx ON secret_rewraps (status, id) WHERE status <> 'done';

-- Columns that accepted only the v1 form now accept v2 as well. Each such CHECK is replaced under its own name.
DO $$
DECLARE
  c record;
  widened text;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND position('~~ ''v1.%''' in pg_get_constraintdef(oid)) > 0
  LOOP
    widened := regexp_replace(c.def, '\(([a-z_]+) ~~ ''v1\.%''::text\)', '((\1 ~~ ''v1.%''::text) OR (\1 ~~ ''v2.%''::text))', 'g');
    IF widened <> c.def THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.table_name, c.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', c.table_name, c.conname, widened);
    END IF;
  END LOOP;
END $$;
