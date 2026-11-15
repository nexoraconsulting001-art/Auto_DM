# Production compose

For a single host, or a small group of hosts, that runs containers without Kubernetes. Nothing here is deployed by the repository.

| File | What it is |
|---|---|
| `compose.yaml` | `web-1` and `web-2` (`node src/server.js`), `worker` (`node src/worker.js`), `lb` (Caddy: round robin over the two web servers, each health-checked on `/readyz`, no stickiness), `redis` (queue and cache) and `analytics` (ClickHouse). Postgres and object storage are outside addresses. |
| `Caddyfile` | The load balancer: Cloudflare's origin certificate for the platform hosts, on-demand certificates for sellers' own domains approved by the app's `/tls/ask`, and the visitor's address from `CF-Connecting-IP` only when the request came from Cloudflare's ranges. |
| `.env.example` | Every variable `compose.yaml` and the `Caddyfile` read. None is a secret. |
| `compose.ci.yaml` | CI and local checks only: adds Postgres and an S3-compatible store as local services. |

Every app container is `read_only` with a `tmpfs` at `/tmp`, runs as `node`, drops every capability with `no-new-privileges`, has a memory limit, a `stop_grace_period` (40 s) longer than `SHUTDOWN_SECONDS` (25 s), and a health check on `/readyz`. Redis and the analytics database sit on an `internal` network with no way out and no published port; only the load balancer publishes ports.

## Secrets: files, never environment values

`DEPLOY_ENV=production`, `SECRETS_DRIVER=file` and `SECRETS_DIR=/run/secrets`: the app reads one file per setting, named as the setting. On the host, `SECRETS_HOST_DIR` holds (owner uid 1000, mode 0400, never in the repository):

- `app/`: `DATABASE_URL` (the app login), `DATABASE_OWNER_URL` (the owner), `REDIS_URL` (`redis://:<password>@redis:6379`), `CLICKHOUSE_URL` (`http://<user>:<password>@analytics:8123`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `DATA_KEY`, `SESSION_SECRET`, `APP_SECRET`, `VERIFY_TOKEN`, `METRICS_TOKEN`, and each provider's secret (`SECRET_SETTINGS` in `src/config.js` lists them all) as it goes live.
- `lb/origin.crt`, `lb/origin.key`: the Cloudflare origin certificate.
- `redis/redis.conf`: `requirepass <the password in REDIS_URL>` (and nothing else is needed).
- `analytics/users.xml`: a ClickHouse `users.d` file defining the user and password of `CLICKHOUSE_URL`.

## Run it

```
docker compose --env-file .env -f compose.yaml run --rm web-1 node scripts/move-to-cloud.js schema
docker compose --env-file .env -f compose.yaml up -d
```

The runbooks in `../runbooks` say when and in what order.

Checked by `docker compose --env-file .env.example -f compose.yaml config -q` in the prod workflow (G-08), and by `test/p9/prod-deploy/compose.test.js`. The QA compose file is `deploy/bhava` and is separate.
