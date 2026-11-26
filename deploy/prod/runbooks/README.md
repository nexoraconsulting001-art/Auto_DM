# Runbooks

What a person does, step by step, with the command for each step and how to tell it worked. A runbook never holds a secret, a server's address or a person's phone number: it names the setting or the role.

| Runbook | When |
|---|---|
| [first-deploy.md](first-deploy.md) | The first time Bhava goes onto a new cluster (or a compose host) |
| [rollout-and-rollback.md](rollout-and-rollback.md) | Every release after that, and going back to the previous one |
| [database-changes.md](database-changes.md) | Writing and shipping a migration while the site is live |
| [restore.md](restore.md) | A backup restored to a new database and object store, checked per business |
| [rotate-master-key.md](rotate-master-key.md) | A new `DATA_KEY`, the old one kept as `DATA_KEY_OLD` until the re-wrap is done (F-66) |
| [move-from-vm.md](move-from-vm.md) | The one-time move of the VM's database and files into the cloud (R-07) |
| [dns-and-cutover.md](dns-and-cutover.md) | Moving DNS with Cloudflare in front: TLS mode, sellers' domains, provider webhooks, the cut-over order and going back |
| [scaling.md](scaling.md) | From 50 to 1,000 businesses: what to raise and what to watch |

Written by other tracks, not here: `incident.md` (the alerts of `../monitoring`) and `go-live.md` (the order of `npm run golive`). Until they exist, their tracks' READMEs are the reference.

Conventions used in every runbook:

- `kubectl -n bhava` is the namespace the Terraform module or the overlay creates. With compose, run the same scripts with `docker compose --env-file .env -f compose.yaml run --rm worker node scripts/...` from `deploy/prod/compose`.
- Every script reads its addresses and credentials from the settings (mounted files under `SECRETS_DIR`), never from the command line, so nothing secret lands in shell history.
- A step "worked" only when its check passes. If a check fails, stop and go back to the last step that worked.
