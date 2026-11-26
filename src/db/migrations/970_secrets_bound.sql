-- 970, R2-SEC-1 (PRD 5.15, F-64): a stored secret is sealed to its record. A value bound to its row starts `v1~<binding id>.`
-- or `v2~<binding id>.` (src/platform/secrets.js), so the columns whose CHECK named the forms take the bound forms too,
-- and still nothing in the clear. Each such CHECK is replaced under its own name, as 900 did. No value is rewritten
-- here: the re-wrap job (src/modules/secret-rotation) binds every stored value to its row, without downtime.
DO $$
DECLARE
  c record;
  widened text;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND position('~~ ''v2.%''' in pg_get_constraintdef(oid)) > 0
  LOOP
    widened := regexp_replace(c.def, '\(([a-z_]+) ~~ ''v2\.%''::text\)', '((\1 ~~ ''v2.%''::text) OR (\1 ~~ ''v1~%''::text) OR (\1 ~~ ''v2~%''::text))', 'g');
    IF widened <> c.def THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.table_name, c.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', c.table_name, c.conname, widened);
    END IF;
  END LOOP;
END $$;
