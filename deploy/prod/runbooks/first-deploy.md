# First deploy

From nothing to a running platform on a new cluster. No traffic reaches it until DNS moves ([dns-and-cutover.md](dns-and-cutover.md)). Who: the platform engineer, with someone who holds the secrets.

## Before you start

- A Kubernetes cluster in an India region (one of `deploy/prod/regions.json`), with an ingress controller, a metrics server, and a Prometheus adapter for the worker's queue autoscaler ([scaling.md](scaling.md)).
- Managed Postgres 16, Redis 7, the analytics database (ClickHouse over HTTP) and two S3-compatible buckets (files, backups), in the same region, reachable only from the cluster's egress addresses.
- The images built from the repository's `Dockerfile` for both architectures and pushed by tag or digest:
  `docker buildx build --platform linux/amd64,linux/arm64 --target web -t <registry>/bhava-web:<version> --push .` and the same with `--target worker`.

## Steps

1. **Postgres: two logins.** On the managed database, as its admin, make the owner login (owns the database, can create roles, is not a superuser) and an empty database it owns. Do not make the app login: the migration step makes it with the password in `DATABASE_URL`.
   Check: the owner can connect and `SELECT current_user` answers its name.
2. **Write the secrets**, one per setting, named as the setting (`DATABASE_URL` is the app login, `DATABASE_OWNER_URL` the owner, then `REDIS_URL`, `CLICKHOUSE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `DATA_KEY`, `SESSION_SECRET`, `APP_SECRET`, `VERIFY_TOKEN`, `METRICS_TOKEN` of 24 characters or more, and each provider's secret as it goes live). Either:
   - by hand from a folder that never touches the repository: `kubectl -n bhava create secret generic bhava-secrets --from-file=<folder>`; or
   - in the outside secret manager under one prefix, and set `secrets.external_store_name` in Terraform (or apply `deploy/prod/k8s/examples/external-secrets/external-secret.yaml`).
   Check: `kubectl -n bhava get secret bhava-secrets -o jsonpath='{.data}' | grep -o '"[A-Z_0-9]*"' | sort` lists the names, and no value is printed.
3. **The origin certificate.** In Cloudflare, make an origin certificate for `<platform domain>` and `*.<platform domain>`; store it as the TLS Secret `bhava-origin-tls` (`kubectl -n bhava create secret tls bhava-origin-tls --cert=<file> --key=<file>`).
4. **Terraform.** Copy `deploy/prod/terraform/terraform.tfvars.example` to a file outside the repository, fill every `set-me` and `example.com`, choose a state backend outside the repository, then:
   `terraform init` · `terraform plan -var-file=<file>` · `terraform apply -var-file=<file>`.
   Apply makes the namespace, runs the migration Job (`node scripts/move-to-cloud.js schema`) and waits for it, then installs everything else.
   Without Terraform: fill the placeholders in `deploy/prod/k8s/overlays/production` and `overlays/production-migrate`, then run steps 2 to 4 of [rollout-and-rollback.md](rollout-and-rollback.md).
   Check: `kubectl -n bhava get job` shows the migration complete; `kubectl -n bhava get pods` shows two web pods and one worker `Running` and `READY 1/1`.
5. **Health.** `kubectl -n bhava port-forward deploy/bhava-web 3000:3000`, then `curl -s localhost:3000/readyz`.
   Check: every dependency answers `up` (storage may say `unchecked`). A `down` names the dependency only: fix that setting and the pod becomes ready by itself.
6. **The production rules.** `kubectl -n bhava logs deploy/bhava-web | grep -i production` shows no refusal. A pod that refuses to start names the rule and the setting (`src/platform/production-guard.js`); fix the setting, never the rule.
7. **The data.** A new platform with no businesses: create the first super admin (`kubectl -n bhava exec deploy/bhava-web -- node scripts/platform-user.js add <email> super_admin`). Moving from the VM instead: [move-from-vm.md](move-from-vm.md) before this step.
8. **Backups.** `kubectl -n bhava create job --from=cronjob/bhava-backup bhava-backup-first`, then `kubectl -n bhava logs job/bhava-backup-first`.
   Check: it prints `Backup saved: backups/daily-<day>.dump`; the worker's nightly backup also reports `backup_last_success_seconds`.
9. **Monitoring.** Point the monitoring stack at `/metrics` on both services with the `METRICS_TOKEN`, and label its namespace `bhava.app/monitoring=true` (Terraform does this when `monitoring_namespace` is set).
10. **Then DNS**, following [dns-and-cutover.md](dns-and-cutover.md).

## With compose instead of Kubernetes

1. On the host, put the secret files under `SECRETS_HOST_DIR` (`app/` one file per setting, `lb/origin.crt` and `lb/origin.key`, `redis/redis.conf`, `analytics/users.xml`), owned by uid 1000, mode 0400.
2. Copy `deploy/prod/compose/.env.example` to `.env` next to it and fill it in.
3. `docker compose --env-file .env -f compose.yaml run --rm web-1 node scripts/move-to-cloud.js schema`.
4. `docker compose --env-file .env -f compose.yaml up -d`, then `docker compose ps`: every service `healthy`.
