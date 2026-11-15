# Production compose

For a single host, or a small group of hosts, that runs containers without Kubernetes. Track: deploy-templates. Empty until that track builds it.

To build here:

- `compose.yaml`: services `web-1` and `web-2` (`node src/server.js`), `worker` (`node src/worker.js`) and `lb` (a load balancer in front of the two web servers, health-checked on `/readyz`, with no session stickiness). Postgres, Redis, the analytics database and object storage are **not** services of this file: they are outside addresses given in the environment (`DATABASE_URL`, `DATABASE_OWNER_URL`, `REDIS_URL`, `CLICKHOUSE_URL`, `S3_*`).
- Every app container: `read_only: true`, `tmpfs: /tmp`, `user: node`, `cap_drop: [ALL]`, `no-new-privileges`, a memory limit, `stop_grace_period` longer than `SHUTDOWN_SECONDS`, and health checks on `/healthz` and `/readyz`.
- `DEPLOY_ENV=production`, `SECRETS_DRIVER=file` with `SECRETS_DIR=/run/secrets`, and each secret as a compose `secrets:` entry from a file outside the repository.
- `.env.example`: every variable the file reads, with no value that is a secret.
- `compose.ci.yaml`: an override that adds Postgres, Redis, the analytics database and an S3-compatible store as local services, for `npm run check:r06` and CI only.

Checked by `docker compose config -q` in `npm run prod:validate` (G-08).
