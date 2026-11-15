# Backup and restore

What is in a backup, how to take one, how to restore, and how to prove it works with `npm run drill`. Written for the person on call. Every step is a command you can paste. Nothing here needs a real customer's data.

## What a backup holds

| In the backup | Not in the backup (keep these safe separately) |
|---|---|
| Every table of every business, the sequences, the grants to the app role and the row-level security settings | `DATA_KEY` (without it the stored Instagram tokens cannot be read), `SESSION_SECRET`, the passwords in `.env` |
| | Uploaded files (the `bhava_files` volume or the file bucket) |

The app login's password is not in the dump either. On a new server the restore makes the `bhava_app` role, and the first start makes the login with the password from `POSTGRES_APP_PASSWORD`.

## Take a backup now (QA server)

The worker makes one every day, named `backups/daily-DD.dump` in the `BACKUP_S3_*` bucket, so about 30 days are kept. To take one now:

```bash
cd ~/bhava/deploy/bhava
docker compose exec worker npm run backup
```

It prints the key it wrote. Check the time of that object in the bucket before you rely on it.

## Check a backup before you restore from it

A backup that came from outside, or one you are not sure of, is read through first. This does not open any database:

```bash
node tools/drill/index.mjs --check-backup path/to/daily-07.dump
```

It needs `pg_restore` 16 on the PATH (or in the folder `PG_BIN_DIR` names). It refuses a file that is cut short, has damaged data, or was written in a format this server does not read, and exits with 1 and the reason. Exit 0 means every block of the file was read.

## Restore (this replaces the whole database)

Only after you have said out loud which database you are replacing.

```bash
cd ~/bhava/deploy/bhava
docker compose stop web worker
docker compose run --rm worker npm run restore -- --confirm=bhava                        # the latest backup
docker compose run --rm worker npm run restore -- --confirm=bhava backups/daily-07.dump  # or a named one
docker compose start web worker
curl -s 127.0.0.1:8140/readyz
```

Then, as a business owner, sign in and open the orders list, and open the shop page of a business. If a sign-in fails with a message about stored tokens, the `DATA_KEY` in `.env` is not the one the backup was made with.

If the restore stops with an error, the database is not left half restored: it runs in one transaction. Start `web` and `worker` again to go back to what was there.

## The drill: prove the restore works (monthly, and before the showcase)

The drill takes a real backup with the real backup code, restores it with the real restore code into an empty Postgres on a second server, and compares everything. It runs on the build machine, never on the VM, and touches nothing it did not start.

Needs: Node 22, `npm install` done, and the PostgreSQL 16 client programs `pg_dump` and `pg_restore` (Windows: install the PostgreSQL 16 command line tools and set `PG_BIN_DIR` to their `bin` folder; Linux: `sudo apt-get install postgresql-client-16`). Without them the drill stops at once and says so, and exits with 1.

```bash
npm run drill                      # the whole drill
npm run drill -- --only refuse     # only the bad-backup part
npm run drill -- --out may         # write the report to test-results/may instead of test-results/drill
```

About five minutes. When it ends it prints one line per step and `PASS` or `FAIL`, and writes `test-results/drill/report.md` and `report.json`. The exit code is 0 for a pass and 1 for anything else (2 for a mistake in how it was started).

| Step | What it does | Fails when |
|---|---|---|
| seed | Starts a Postgres set like the QA server's, makes three businesses through the console API and runs 12 seconds of traffic through the simulators, then stops web and worker | the source has fewer than two businesses |
| backup | `runBackup` from `src/backup.js`, timed | the file is empty |
| restore | `runRestore` into a second, empty Postgres, timed | it takes longer than `drill.restoreWithinSeconds` in `tools/load/budgets.json`, or it errors |
| compare | For every table: row count and an md5 over the rows in key order, for the whole table and for each business; the sequences | any difference at all, named by table and business |
| fence | As the restricted app login: each business sees only its own rows (as many as the owner counted), none with no business set; row-level security settings the same as the source | any row of another business is visible |
| logins | The owner and the app login both connect; the app login is the restricted one and cannot make, alter or drop a table; the grants are the same as the source | any difference or any permission the app login should not have |
| start | Starts web and worker on the restored copy; `/readyz`, `/healthz`, a seller sign-in, the orders list and a shop page work; one business's sign-in is refused on another's address | any of those fails |
| refuse | Makes three bad copies of the backup (last third cut off; bytes in the middle overwritten; format version changed). Each is refused by the read-through check, and the real restore, tried against the target, refuses it and leaves it as it was (counts and checksums again) | a bad backup is accepted by either, or the target changes |

The report never contains a row of data, a password or a key. A failure message names the table and the business, with the two counts.

### What a failure means

- **compare** differences: the restore is not the same as the backup. Do not rely on the backups until it is understood. Keep the report.
- **fence** or **logins** problems: after a restore a business could see another's rows, or the app login has more power than it should. Treat as a security fault.
- **refuse** accepted a bad backup: the nightly restore path does not check a file before it starts. Run `--check-backup` first (above) until that is changed.

## Repeat the drill on the QA server later

The drill needs a machine with Node and the client programs, and it makes its own temporary Postgres servers on free ports. It does not need the `bhava` containers and must not stop them. On the shared VM, only with the owner's say-so:

1. `free -h`. The drill uses about 1.5 GB at its peak (two Postgres servers, two Node processes). Do not start it if less than 2 GB is free.
2. In a separate folder (not the live checkout): `git clone` the repository, `git checkout bhava/build`, `npm ci`.
3. `sudo apt-get install postgresql-client-16` if `pg_dump --version` does not already print 16.
4. `npm run drill -- --out qa` and read `test-results/qa/report.md`. It deletes its temporary servers and folders when it ends; check with `ps` that no `postgres` of its own is left.
5. To drill a real nightly backup instead of the seeded one, restore it into a scratch database inside the QA Postgres and compare by hand. Only the `bhava` project is touched, and only a new database:

```bash
cd ~/bhava/deploy/bhava
docker compose exec postgres createdb -U bhava bhava_scratch
# copy the downloaded dump into the container, then:
docker compose exec postgres pg_restore -U bhava --no-owner --exit-on-error --single-transaction -d bhava_scratch /tmp/daily-07.dump
docker compose exec postgres psql -U bhava -d bhava_scratch -c "SELECT count(*) FROM tenants"
docker compose exec postgres dropdb -U bhava bhava_scratch
```

Write what you did and the counts in the report folder's notes, and name the dump you used by its key only.
