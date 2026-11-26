# Production templates

Everything needed to run Bhava in production, on any cloud. Nothing here is deployed by this repository, and nothing names a cloud provider's service or SDK: the templates take addresses as variables.

| Folder | What it holds |
|---|---|
| `compose/` | A production compose file: two web servers, one worker and a load balancer, with Postgres, Redis, the analytics database and object storage as outside addresses |
| `k8s/` | Kubernetes manifests: a kustomize base and an overlay |
| `terraform/` | Provider-neutral Terraform: it takes the cluster and the managed Postgres, Redis and bucket addresses as variables |
| `monitoring/` | Prometheus rules and their unit tests, Alertmanager routes, Grafana dashboards, the uptime probe |
| `runbooks/` | What a person does: deploy, roll back, rotate the master key, restore, cut over, an incident |

Rules every folder keeps:

- **One region variable, India only.** `regions.json` here is the list of India regions across providers and the name of the one variable (`region`) that may hold one. No other file names a region. The Terraform variable validates against the list, and `npm run prod:validate` checks both.
- **No secrets.** Templates name secrets and mount them; they never hold a value. The app reads them with `SECRETS_DRIVER=file` (a mounted directory, one file per setting) or `http` (a secret manager), see `src/platform/secret-source.js`.
- **`DEPLOY_ENV=production`** is set by these templates and nowhere else. With it the server refuses to start unless every rule in `src/platform/production-guard.js` holds.
- **The image** is the repository's `Dockerfile`: one image, two commands (`node src/server.js`, `node src/worker.js`), a non-root user, a read-only file system with `/tmp` as the only writable mount, on arm64 and amd64.
- **Probes**: `/healthz` (liveness), `/readyz` (readiness) and `/startupz` on the web port and on the worker's `WORKER_HEALTH_PORT`. `SIGTERM` drains within `SHUTDOWN_SECONDS` (the first `DRAIN_GRACE_SECONDS`, 2 by default, answer 503 with the listener still open so a balancer moves on), so the platform's grace period must be longer.
- **Metrics**: `/metrics` with `Authorization: Bearer <METRICS_TOKEN>`. Every name is in `src/contracts/metrics.js`; a rule or dashboard that names anything else fails its test.

Validate everything with `npm run prod:validate`. CI runs the same in `.github/workflows/prod.yml`, each tool from its public container image.
