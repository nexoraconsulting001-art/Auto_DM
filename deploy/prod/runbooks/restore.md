# Restore

A backup restored to a NEW database and object store, checked business by business. Never restore over the live database: build the copy next to it, check it, and switch only if the live one is lost.

`npm run check:r07` rehearses all of this on local services; run it before relying on a backup you have never restored.

## Steps

1. **Pick the backup.** The worker and the `bhava-backup` CronJob write `backups/daily-<day of month>.dump` to the backup bucket, and `backups/latest` names the newest. Download it to the machine that runs the restore (a pod with the image, or a workstation with the Postgres 16 client tools).
2. **A new, empty database** on the managed Postgres, owned by the owner login. The restore refuses one that holds anything.
3. **Settings for the new database.** A copy of `bhava-secrets` whose `DATABASE_OWNER_URL` and `DATABASE_URL` point at the new database (new passwords).
4. **Restore.** `node scripts/move-to-cloud.js restore --dump <file>`.
   It checks the whole archive can be read first, restores it in one transaction (a failure leaves the database empty, so run it again once the cause is fixed), then makes the app login.
   Check: it prints `restore: restored` (or `already_restored` on a second run).
5. **Check it.** If the damaged database still answers, take a fingerprint of it read-only first (`node scripts/move-to-cloud.js fingerprint --out <file>` with its settings), then on the new one:
   `node scripts/move-to-cloud.js verify --fingerprint <file>`
   Check: `everything matches`. Each `DIFFERENT` line names a table and a business. With no source left to compare, verify against the fingerprint taken with the backup, if there is one, and spot-check a few businesses in the Platform Console.
6. **Files.** Object storage keeps files on its own; if the bucket is lost too, restore the provider's bucket backup or versioning into a new bucket, then `node scripts/copy-files.js --from <files folder> --state <file> --verify` against it.
7. **Analytics.** `node scripts/move-to-cloud.js rollups` rebuilds the summaries in the analytics database from the restored Postgres.
8. **Switch.** Point `bhava-secrets` at the new database, then roll the pods (`kubectl -n bhava rollout restart deploy/bhava-web deploy/bhava-worker`).
   Check: `/readyz` is `up`; a seller can sign in; the newest orders before the backup's time are there.
9. Write down what was lost: everything after the backup's time. Tell the businesses affected.
