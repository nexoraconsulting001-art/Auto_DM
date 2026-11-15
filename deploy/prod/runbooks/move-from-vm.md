# Moving from the VM to the cloud (R-07)

The one-time move of the QA/early-production VM's database and uploaded files into the managed Postgres and object storage. Nothing on the VM is changed by any step: the VM stays ready to take traffic back until the move is signed off. Rehearse the whole thing with `npm run check:r07` first.

What moves: the Postgres database (every business's rows, sequences, grants and row-level security), the files of local storage (`STORAGE_DIR`, the `files` volume), and the analytics summaries. What does not: sessions stay valid (they are rows in the database), so sellers stay signed in.

## The day before

1. **Do [first-deploy.md](first-deploy.md) steps 1 to 6** on the cloud, but leave the database EMPTY: skip the migration step for now. The restore refuses a database that holds anything.
2. **Lower the DNS TTL** of every platform host to 300 seconds ([dns-and-cutover.md](dns-and-cutover.md)).
3. **A first copy of the files**, while the VM still runs: on the VM,
   `docker run --rm -v bhava_files:/data/files:ro -v <work folder>:/move <new web image> node scripts/copy-files.js --from /data/files --state /move/copy-state.jsonl`
   with the cloud's `STORAGE_DRIVER=s3` and `S3_*` settings passed as files (`-e SECRETS_DRIVER=file -e SECRETS_DIR=/move/secrets` and the folder mounted read-only). The files volume is mounted read-only, so the source cannot change.
   Check: it ends `copy-files: N copied`. It refuses a bucket that is not empty; if it stops halfway, run it again: it resumes.

## The move (the site is in maintenance for its length)

1. **Stop writes on the VM:** `docker compose stop worker web` in `deploy/bhava`. Postgres keeps running.
2. **The last backup:** `docker compose run --rm worker npm run backup`, then download `backups/latest`'s dump from the backup bucket. (Or `pg_dump --format=custom --no-owner` as the owner login into a file.)
3. **The fingerprint**, from the same stopped database, read-only:
   `docker compose run --rm -v <work folder>:/move <new web image> node scripts/move-to-cloud.js fingerprint --out /move/vm-fingerprint.json`
   (on the VM's network, with the VM's `DATABASE_OWNER_URL`). It holds counts and checksums only, no rows.
4. **The rest of the files:** run the copy-files command of "the day before" again with the same state file. Then `... node scripts/copy-files.js --from /data/files --state /move/copy-state.jsonl --verify`.
   Check: `everything matches`, with each business's file count.
5. **Restore into the cloud**, from a pod or a machine with the cloud's settings:
   `node scripts/move-to-cloud.js restore --dump <dump file>`
   Check: `restore: restored`. A failure leaves the cloud database empty: fix the cause (it is named) and run the same command again.
6. **Verify, before switching anything:**
   `node scripts/move-to-cloud.js verify --fingerprint vm-fingerprint.json --files copy-state.jsonl`
   Check: `everything matches`. Any `DIFFERENT` line (a table and a business, a count or a checksum, a login, the fence, a file) stops the move: do not switch, start the VM again (step 1 of "Going back") and find the cause.
7. **Now the schema:** `node scripts/move-to-cloud.js schema` (or `terraform apply`, which runs the migration Job), so this release's migrations run on the verified copy.
8. **The analytics summaries:** `node scripts/move-to-cloud.js rollups`.
   Check: `totals match`.
9. **Start the cloud** (`terraform apply`, or the rollout of [rollout-and-rollback.md](rollout-and-rollback.md)) and check `/readyz` is `up`.
10. **Switch DNS** following [dns-and-cutover.md](dns-and-cutover.md), then end maintenance.

## Going back

1. Until DNS moved: nothing to undo. `docker compose start web worker` on the VM.
2. After DNS moved, before sign-off: put DNS back ([dns-and-cutover.md](dns-and-cutover.md)), then start the VM. Orders taken in the cloud meanwhile must be carried back by hand from the Platform Console; keep this window short.
3. Keep the VM, its volumes and the last backup untouched for 30 days after sign-off.
