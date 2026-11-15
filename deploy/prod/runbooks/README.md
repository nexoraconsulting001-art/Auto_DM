# Runbooks

What a person does, step by step, with the command for each step and how to tell it worked. Tracks: runtime, secrets, golive. Empty until those tracks write them.

To write here:

- `deploy.md`: a release from image to traffic, and the roll back.
- `rotate-master-key.md`: a new `DATA_KEY`, the old one moved to `DATA_KEY_OLD`, the re-wrap job (`src/modules/secret-rotation`) to completion, then the old key retired (F-66).
- `secrets.md`: where each secret lives, how one is replaced, and what a failing secret manager looks like (G-04, G-05).
- `restore.md`: a backup restored to a new database and object store, with counts and checksums per business (`npm run check:r07`, G-12).
- `cutover.md`: moving an old single-shop app onto the platform with the Phase 8 importer; its dry run reports counts and writes nothing (G-20).
- `incident.md`: the alerts of `../monitoring`, each with what to look at first and how to pause sending.
- `go-live.md`: the order of the go-live checklist (`npm run golive`), who does what, and opening sign-up (closed, invite, public).

A runbook never holds a secret, a server's address or a person's phone number: it names the setting or the role.
