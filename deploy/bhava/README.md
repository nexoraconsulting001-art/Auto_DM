# Bhava QA on the shared Oracle VM

Runs next to the live apps, without touching them.

| | |
|---|---|
| Folder on the VM | `~/bhava` |
| Compose project | `bhava` (`postgres`, `web`, `worker`) |
| Port | `127.0.0.1:8120` (add it to the port register) |
| Data | Docker volumes `bhava_pgdata` and `bhava_files` |
| Secrets | `~/bhava/deploy/bhava/.env`, on the VM only |
| Memory limits | Postgres 512 MB, web 512 MB, worker 384 MB |

**Shared-VM rules:** only touch the `bhava` project. Never stop other containers, never edit other Caddy site files, never publish on `0.0.0.0`, and never run `docker compose down -v`.

Mehta Mart's live app updates with `git pull` on `claude/affectionate-rubin-it8bkq`. Bhava work stays off that branch until the switch in Phase 10, so it can't reach the live app.

## First deploy

```bash
free -h                                    # all sites share 6 GB; Bhava needs up to about 1.4 GB
git clone https://github.com/nexoraconsulting001-art/Auto_DM ~/bhava
cd ~/bhava && git checkout bhava/p0-foundation
cd deploy/bhava && cp .env.example .env && nano .env
docker compose up -d --build
docker compose ps                          # postgres, web and worker healthy
curl -s 127.0.0.1:8120/readyz              # {"ok":true,...}
```

## Add a test business

Each business needs its own address. `mehtamart` and `plantstore` are already taken by the live apps on the sslip domain, so QA slugs start with `bhava-`.

```bash
docker compose exec web npm run tenant -- create bhava-mehta "Mehta Mart"
docker compose exec -e OWNER_PASSWORD='choose-one' web npm run tenant -- owner bhava-mehta 9XXXXXXXXX
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh bhava-mehta proxy 8120
```

The site is then at `https://bhava-mehta.140-238-251-141.sslip.io`. Log in on `/login`.

## Update

```bash
cd ~/bhava && git pull && cd deploy/bhava && free -h && docker compose up -d --build
```

Database changes apply on start.

## Backups

The worker uploads a backup every day to the `BACKUP_S3_*` bucket, named `backups/daily-DD.dump`, so about 30 are kept. To take one now:

```bash
docker compose exec worker npm run backup
```

To restore (this replaces the whole database):

```bash
docker compose stop web worker
docker compose run --rm worker npm run restore -- --confirm=bhava
docker compose start web worker
```

## Monitoring

`/readyz` shows whether the app can reach its database and which module drivers it runs. `/metrics` needs `Authorization: Bearer <METRICS_TOKEN>`.
