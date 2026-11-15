# Database changes while live

Migrations run before new code takes traffic (the migration Job, then the web servers themselves at start under the same advisory lock, with `/readyz` answering `behind` until they have). For the whole of a rollout the old code and the new code run side by side on the new schema, so every migration must keep the old code working. The pattern is expand, then contract, over two or more releases.

## Writing a migration

1. **Expand only.** A release may add a table, a nullable column or a column with a default, an index (`CREATE INDEX` on a small table; on a large one in its own migration), a constraint added `NOT VALID` and validated in a later migration, a new enum value, a new view.
2. **Never in the same release as the code that stops using it:** dropping or renaming a column or table, making a column `NOT NULL`, changing a type, tightening a check. Those are the contract step, in a later release, once no running code reads the old shape.
3. **Renames are three releases:** add the new column and write both; backfill and read the new one; drop the old one.
4. **Backfills in batches**, in a job or a later migration, never one statement over a large table inside the migration that the rollout waits for (the Job has 15 minutes).
5. **Every new table** that holds a business's data carries `tenant_id`, its row-level security fence and composite foreign keys, like every other.
6. **Numbers:** a migration's file number is new and higher than every other; this phase's are 900 to 999.

## Shipping it

1. Run the release's tests on Postgres (`TEST_DATABASE_URL`) and on two logins (`TEST_DB_LOGINS=2`).
2. Before the release, look at what the migration locks: on a copy of production (a restore, [restore.md](restore.md)), time it with `\timing` in `psql`.
3. Roll out as usual ([rollout-and-rollback.md](rollout-and-rollback.md)); the Job runs the migration while the old code keeps serving.
   Check: the Job completes; the dashboards show no rise in errors from the old pods during it; then the new pods turn ready.
4. If the old code fails against the new schema during the rollout, the migration broke the rule above: roll the image forward with a fix, do not restore.
5. The contract step goes in a later release, only after every pod runs code that no longer reads the old shape (`kubectl -n bhava get pods -o jsonpath='{..image}'` shows one tag).
