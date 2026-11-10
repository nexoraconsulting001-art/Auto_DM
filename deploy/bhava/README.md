# Bhava QA on the shared Oracle VM

Runs next to the live apps, without touching them.

| | |
|---|---|
| Folder on the VM | `~/bhava` |
| Compose project | `bhava` (`postgres`, `web`, `worker`) |
| Port | `127.0.0.1:8140` (add it to the port register) |
| Data | Docker volumes `bhava_pgdata` and `bhava_files` |
| Secrets | `~/bhava/deploy/bhava/.env`, on the VM only |
| Memory limits | Postgres 512 MB, web 512 MB, worker 384 MB |

**Shared-VM rules:** only touch the `bhava` project. Never stop other containers, never edit other Caddy site files, never publish on `0.0.0.0`, and never run `docker compose down -v`.

## First deploy

```bash
free -h                                    # all sites share 6 GB; Bhava needs up to about 1.4 GB
git clone https://github.com/nexoraconsulting001-art/Auto_DM ~/bhava
cd ~/bhava && git checkout bhava/build
cd deploy/bhava && cp .env.example .env && nano .env
docker compose up -d --build
docker compose ps                          # postgres, web and worker healthy
curl -s 127.0.0.1:8140/readyz              # {"ok":true,...}
```

## Add a test business

Each business needs its own address. QA slugs start with `bhava-`. `bhava`, `www`, `app`, `api` and `admin` are reserved.

```bash
docker compose exec web npm run tenant -- create bhava-mehta "Mehta Mart"
docker compose exec -e OWNER_PASSWORD='choose-one' web npm run tenant -- owner bhava-mehta 9XXXXXXXXX
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh bhava-mehta proxy 8140
```

The site is then at `https://bhava-mehta.<PLATFORM_DOMAIN>`. Log in on `/login`.

Each business sends with its own Instagram token, stored encrypted (needs `DATA_KEY`):

```bash
docker compose exec web npm run tenant -- link-ig bhava-mehta <instagram user id> <username>
docker compose exec -e IG_ACCESS_TOKEN='paste-it-here' web npm run tenant -- ig-token bhava-mehta <instagram user id>
```

## Add a Bhava team member

They sign in only on the platform host, `PLATFORM_HOST` (by default `admin.<PLATFORM_DOMAIN>`).

```bash
docker compose exec -e PLATFORM_PASSWORD='choose-one' web npm run platform-user -- add someone@example.com super_admin
```

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
