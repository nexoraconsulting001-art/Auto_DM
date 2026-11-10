# Deploying to the Oracle VM

This puts the store on the shared Oracle VM (`svc-agent`, Arm64, 6 GB RAM) behind Caddy, following DEPLOYMENT-GUIDE.md.

| | |
|---|---|
| App name | `mehtamart` |
| Port | `127.0.0.1:8100` (record it in the port register) |
| Address | https://mehtamart.VM-IP-DASHED.sslip.io |
| Data | Docker volume `mehtamart_data`, mounted at `/data` (database and uploaded photos) |
| Secrets | `deploy/.env` on the VM only |

The VM is shared: only touch the `mehtamart` project. Never stop or restart other containers, never edit other Caddy site files, never publish on `0.0.0.0`, and never run `docker compose down -v` (it deletes the store's data).

## First deploy

SSH in (disconnect the Voltas VPN first):

```powershell
ssh -i "$env:USERPROFILE\.ssh\oracle-svc-agent.key" ubuntu@VM-IP
```

Then on the VM:

```bash
# 0. Is there room? All sites share 6 GB. The store needs about 300 MB.
free -h

# 1. Get the code
git clone https://github.com/Shashank-Codes-bit/Auto_DM ~/mehtamart
cd ~/mehtamart
git checkout claude/affectionate-rubin-it8bkq
cd deploy

# 2. Secrets: fill in every value (owner phone + password, session secret, Instagram keys)
cp .env.example .env
nano .env

# 3. Build and start (the first build on Arm takes a few minutes)
docker compose up -d --build
docker compose ps                                                # State: running
curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:8100/health  # expect 200

# 4. Put it on the internet through Caddy
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh mehtamart proxy 8100
#    → https://mehtamart.VM-IP-DASHED.sslip.io  (the first visit fetches the certificate)
```

## After it's up

1. **Meta webhook:** in the Meta app, open Instagram → API setup with Instagram login → Configure webhooks. Set the Callback URL to `https://mehtamart.VM-IP-DASHED.sslip.io/webhook` and the verify token to your `VERIFY_TOKEN`.
2. **Log in:** open `/login` with `ADMIN_PHONE` and `ADMIN_PASSWORD`. You land in the admin panel.
3. **Demo data:** Admin → Settings → **Load demo data**. This fills the categories and products and sets up your 3 newest reels.
4. **Test:** comment `LINK` on a reel from your tester account. The DM's button should open the new address.

## Giving someone admin rights

Everyone who signs up on the website is a customer. To make someone an admin, they sign up first, then you run this on the VM. It stops the store for a few seconds, because only one process can open the database:

```bash
cd ~/mehtamart/deploy
docker compose stop web && docker compose run --rm web npm run role -- 9876543210 admin && docker compose start web
```

Use `customer` instead of `admin` to take the rights away, and `npm run role -- list` (same wrapper) to see who is an admin. They log in on `/login` with their own password.

## Updating, logs, rollback

```bash
cd ~/mehtamart && git pull && cd deploy && docker compose up -d --build   # deploy a new version
docker compose logs -f web                                                # follow the logs
docker compose restart web                                                # restart only this app
git log --oneline -5 && git checkout <good-commit> && docker compose up -d --build   # roll back
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh mehtamart remove # take it off the internet
```

## Backups

All store data is in the `mehtamart_data` volume. To copy it to a dated archive in your home folder:

```bash
cd ~/mehtamart/deploy
docker compose stop web
docker run --rm -v mehtamart_data:/data -v ~/backups:/backup busybox tar czf /backup/mehtamart-$(date +%F).tgz -C /data .
docker compose start web
```

Restoring is the same with `tar xzf` into the volume while the app is stopped.

## Checklist

- [ ] `docker compose ps` shows `web` running, with `restart: unless-stopped`.
- [ ] `curl 127.0.0.1:8100/health` on the VM returns 200.
- [ ] https://mehtamart.VM-IP-DASHED.sslip.io opens with a valid certificate.
- [ ] The other sites still work: https://VM-IP-DASHED.sslip.io/health and https://alerts.VM-IP-DASHED.sslip.io.
- [ ] `deploy/.env` is on the VM only: `git status` doesn't list it.
- [ ] Port 8100 → `mehtamart` is recorded in the port register (DEPLOYMENT-GUIDE.md section 4 and `infra/oracle-vm/README.md`).
