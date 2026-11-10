# Project handoff: Auto DM + Mehta Mart store

This file holds the full context of the project, so a new chat (or a new person) can pick up from here. Paste the "Start here" section at the bottom into a new chat.

> **Bhava, the multi-business platform, is being built on branch `bhava/p0-foundation`.** Requirements are in the "Bhava PRD" doc and the phases in the "Bhava Build Plan" doc. On that branch: migrations in `src/db/migrations`, the current business in `src/tenancy.js` (every business repo refuses to run without one), switchable modules in `src/platform`, background jobs in `src/worker.js`, and the QA deploy in `deploy/bhava`. The rest of this file describes the live single-shop Mehta Mart app. It stays on `claude/affectionate-rubin-it8bkq` until the switch in Phase 10. Never merge Bhava work into that branch: the VM deploys it with `git pull`.

## 1. Summary

When someone comments a keyword (e.g. `LINK`) on an Instagram reel, they get an automatic DM with a **Shop now** button. The button opens a store page with only that reel's products (1–20). Each reel has its own link.

That grew into a full online store, shown as a demo for **Mehta Mart** (mehtamartmhm.com):
- a home page, shop, categories, product pages and an Instagram-style Reels tab;
- shopper accounts, a checkout and a demo UPI payment page;
- an admin panel for the owner, on the same site and shown based on login.

It's live on the Oracle VM.

## 2. Key facts

| | |
|---|---|
| Repo | `Shashank-Codes-bit/Auto_DM` (public) |
| Branch | `claude/affectionate-rubin-it8bkq`. All work is here, with no PR. |
| Live store | https://mehtamart.VM-IP-DASHED.sslip.io |
| Admin | https://mehtamart.VM-IP-DASHED.sslip.io/admin (log in on `/login` with `ADMIN_PHONE` / `ADMIN_PASSWORD`) |
| Health check | `/health` returns `ok` |
| Instagram business account | `@_shoppingforher_`, IG_USER_ID `17841465186333519` |
| Test commenter | `_squenza` (an Instagram tester on the Meta app). Comments from the business account itself are skipped. |
| Meta webhook | Callback `https://mehtamart.VM-IP-DASHED.sslip.io/webhook`, verify token in the server's `.env`, field `comments` |
| Server | Oracle VM `svc-agent`, VM-IP, Arm64, 1 OCPU, 6 GB RAM, Ubuntu 24.04, shared with other sites |
| App on the VM | `~/mehtamart`, Docker Compose project `mehtamart`, service `web`, `127.0.0.1:8100`, volume `mehtamart_data` mounted at `/data`, secrets in `~/mehtamart/deploy/.env` |
| Front door | Caddy, site file `/etc/caddy/sites/mehtamart.caddy` (added with `add-site.sh`) |
| Shared with the Auto DM plugin | Since 2026-10-15 the same Instagram account also runs the Plant Store demo (repo `Shashank-Codes-bit/Auto_DM_Plugin`, `~/plantstore-dm`, port 8110, https://plantstore.VM-IP-DASHED.sslip.io). Comments on reels this store doesn't use are passed on there (`FORWARD_WEBHOOK_URL`), and `/l/<slug>` redirects there (`PLUGIN_URL`). Map each reel in one app only. See that repo's HANDOFF.md |
| Old dev setup | GitHub Codespace on port 3000. It's no longer needed now that Meta points to the VM. |

## 3. How it works

1. **Comment arrives.** Meta sends a `comments` webhook to `POST /webhook`. The signature (`X-Hub-Signature-256`) is checked with `APP_SECRET`.
2. **Matching** (`src/handler.js`):
   - It skips comments from our own account, reels with no store, and paused reels.
   - Keywords are whole words and case doesn't matter.
   - Each comment is claimed once in the `activity` table, so duplicate deliveries send one DM.
   - The per-person limit is off (`ONE_DM_PER_USER=0`).
3. **The DM:**
   - It's sent as an Instagram **Private Reply** (`/{IG_USER_ID}/messages` with `recipient.comment_id`). Instagram allows one per comment, within 7 days.
   - It's sent as a button template. If Instagram rejects that, it falls back to plain text with the link.
   - An optional public reply goes under the comment.
   - The link is `PUBLIC_BASE_URL/r/<slug>?src=dm`.
4. **Reel store** `/r/<slug>`: the reel's products in the order they appear in the video. Each visit is counted (`visits` table).
5. **Instagram's in-app browser:**
   - The store works inside it.
   - An "Open full store in Chrome/Safari" block at the end of the page is always shown. A floating card appears once per session when the shopper reaches the end of the page.
   - The bag travels to the real browser in the link (`/shop?bag=…`).
6. **Checkout needs a login.**
   - Guests who tap Checkout go to `/login?next=/checkout` (with a "Create an account" link) and come back with the bag kept. The bag is stored in the browser.
   - Prices, delivery and stock are recalculated on the server.
   - Stock is reserved when the order is placed and restored on cancel.
7. **Payment is a demo.** `/order/<token>` shows a "Pay with UPI app" button (`upi://pay?...`), a UPI QR and an "I've paid" button. The owner confirms the payment in the admin panel. No real gateway is connected yet.

## 4. Features

**Storefront** (Light & gold design; fonts Bricolage Grotesque and Figtree):
- **Home `/`:** hero with today's top deal, category circles, price chips (Under ₹99/199/299/599/999, ₹1,000+), "From our reels" with Shop now, "Today's best deals" (featured products, otherwise the biggest discounts), trust points, a bulk-order WhatsApp banner, and a footer with GSTIN.
- **Shop `/shop` and categories `/c/<slug>`:** search, category chips, a "Filter & sort" bottom sheet (price band; sort by popular, discount or price), and "Show more" 24 at a time. Filters stay in the URL.
- **Product page `/p/<slug>`:** gallery with dots, MRP and % off, options (e.g. size), quantity, description, "You may also like", and a sticky Add to bag bar.
- **Reels tab `/reels`:** full-screen reels that snap one at a time. The reel on screen autoplays muted and a tap toggles sound. Each has a product strip and Shop now. `GET /api/reels?cursor=` loads 8 more at a time, and the feed ends with "You're all caught up". `/reels#<slug>` jumps to a reel. On desktop the arrow keys move between reels.
- **Other pages:** `/about`, plus a mobile tab bar (Home, Shop, Reels, Bag).

**Accounts and roles:**
- **Login:** phone + password (scrypt hashes) on `/login` and `/signup`. Sessions are a signed HttpOnly cookie (`sid`) lasting 30 days. Logged-in forms carry a CSRF token, and logins are rate-limited.
- **My account `/account`:** orders, the saved address (filled in at the next checkout) and a password change.
- **Every signup is a customer.** Admin rights come only from the server command `npm run role` (section 8).
- **The `.env` owner** (`ADMIN_PHONE` + `ADMIN_PASSWORD`) is created or made admin on every start. Their password always comes from `.env`.
- **Customers who open `/admin`** are sent to `/account`.

**Owner tools:**
- **Owner bar** on every store page, with "Edit this page". Edit buttons appear on product cards, the category header and reels.
- **Dashboard setup checklist** that ticks itself off: connect Instagram, store details, products, first reel store, first comment, first order. It can be hidden.
- **Admin sections:**
  - **Dashboard:** numbers per reel (DMs, then visits, then orders).
  - **Orders:** status flow, plus a WhatsApp link to the customer.
  - **Products:** photos by upload or link, categories, Featured switch, archive.
  - **Categories:** add, hide and reorder, with an image.
  - **Reels:** pick 1–20 products per reel, keywords, DM text, button text, public reply, live or paused.
  - **Customers:** order counts and spend, and a password reset that shows a new password for the owner to send on WhatsApp.
  - **DM activity.**
  - **Settings:** store info, home and About text, trust points, GSTIN, delivery fee, free-delivery threshold, UPI ID, contacts, the Instagram connection, and **Load demo data**.

**Demo data** (`seed/mehtamart.json` v2, loaded from Admin → Settings → Load demo data):
- 13 Mehta Mart collections as categories, with images.
- 178 products with real names, prices, MRPs, descriptions and photo links (from cdn.dotpe.in). The 8 biggest discounts are featured.
- Store text: tagline "Think Shopping. Think Us!", about text, WhatsApp 919320001717, email, GSTIN 27ATJPM7943G1Z9.
- The 3 newest reels map to Kitchen Creations (`KITCHEN`, `LINK`), Fresh Start Cleaning (`CLEAN`, `LINK`) and Trending Toys (`TOYS`, `LINK`).
- It's safe to load again: categories and products match by name, and settings the owner has changed are kept.

## 5. Code map

| Path | What it is |
|---|---|
| `src/server.js` | Builds the Express 5 app: security headers, `/health`, webhook, mounts the routes. On start it opens the DB and runs `ensureOwner`. `trust proxy` is 1. |
| `src/config.js` | Reads `.env` |
| `src/auth.js` | Session cookie, CSRF, rate limit, `requireUser` / `requireAdmin`, `safeNext` |
| `src/db/index.js`, `src/db/schema.sql` | Postgres (`DATABASE_URL`) or embedded **PGlite** in `DATA_DIR`. The schema is applied on every start and is safe to re-run. Money is stored in paise. |
| `src/repos/*.js` | Data access: products, categories, reels (incl. `feed`), orders, users, settings, activity, stats, media |
| `src/handler.js` | Comment → DM logic |
| `src/instagram.js` | Graph API calls (graph.instagram.com). `DRY_RUN=1` only logs. |
| `src/routes/store.js` | Storefront pages, `/api/products`, `/api/reels`, `/api/orders`, `/media/:id` |
| `src/routes/account.js` | `/login`, `/signup`, `/logout`, `/account` |
| `src/routes/admin.js` | Admin panel, checklist, categories, customers, demo data |
| `src/views/store.js`, `src/views/admin.js` | Server-rendered HTML (safe `html` tagged template in `src/views/html.js`) |
| `src/views/assets.js` | Fingerprints `/static` URLs (`?v=hash`) so browsers load new CSS and JS after each deploy |
| `public/` | `store.css`, `cart.js` (bag, sheets, checkout, Chrome prompt), `reels.js` (feed), `admin.css`, `admin.js` |
| `scripts/seed.js` | `seedDemo`, `newestReels`, `npm run seed` |
| `scripts/role.js` | `npm run role -- list`, `-- <phone> admin`, `-- <phone> customer` |
| `seed/mehtamart.json` | Demo data v2 |
| `test/` | `node --test`: 34 tests (handler, store, http, accounts, shop, seed) |
| `Dockerfile`, `.dockerignore`, `deploy/compose.yaml`, `deploy/.env.example`, `DEPLOY.md` | Oracle VM deployment |
| `render.yaml` | Old alternative host config (not used) |

Stack: Node 22 (ESM), Express 5, `pg`, `@electric-sql/pglite`, `multer`, `qrcode`, `dotenv`. There's no frontend framework or build step.

## 6. Decisions made

- One shared product catalog. Each reel shows 1–20 products from it.
- Payments are a demo QR for now. A real gateway comes later.
- Light & gold design, from the approved samples artifact.
- The store is public; only checkout needs a login. DM visitors must not hit a login wall.
- Admin rights come only from the server command. There's no UI to grant them. Signups default to customer.
- No SMS or email service, so forgotten passwords are reset by the owner in Admin → Customers.
- Every keyword comment gets a DM; there's no per-user limit (for testing).
- Data lives in the built-in PGlite database on the VM's Docker volume. **PGlite can only be open in one process at a time,** so CLI scripts need the app stopped.

## 7. Environment variables (`.env`; values are never committed)

| Key | Meaning |
|---|---|
| `IG_ACCESS_TOKEN` | Long-lived Instagram token (expires after 60 days) |
| `IG_USER_ID` | 17841465186333519 |
| `APP_SECRET` | Instagram app secret, used to verify webhook signatures. If webhooks fail with "bad signature", try the other secret from App settings → Basic. |
| `VERIFY_TOKEN` | Must match Meta's webhook settings |
| `GRAPH_VERSION` | `v23.0` |
| `DRY_RUN` | `1` = log DMs instead of sending them |
| `ONE_DM_PER_USER` | `1` = one DM per person per reel |
| `PUBLIC_BASE_URL` | `https://mehtamart.VM-IP-DASHED.sslip.io` (the link used in DMs) |
| `ADMIN_PHONE`, `ADMIN_PASSWORD` | Owner login. The account is made admin on every start. |
| `SESSION_SECRET` | Long random string (`openssl rand -hex 32`) |
| `DATABASE_URL` | Empty = built-in database. `DATA_DIR=/data/pgdata` is set in `compose.yaml`. |
| `FORWARD_WEBHOOK_URL` | Optional. Comments on reels this store doesn't use are passed on, unchanged (same body and Meta signature), to this URL. Used to share the Instagram account with the Auto DM plugin (repo `Auto_DM_Plugin`). |
| `PLUGIN_URL` | Optional. `/l/<slug>` (the links in the plugin's DMs) redirects to `PLUGIN_URL/r/<slug>`. |

## 8. Operations runbook (Oracle VM)

**SSH** from Windows PowerShell:
```powershell
ssh -i "$env:USERPROFILE\.ssh\oracle-svc-agent.key" ubuntu@VM-IP
```
Disconnect the Voltas VPN first. If it times out, the network is blocking port 22: use a phone hotspot or Oracle Cloud Shell.

**Deploy an update:**
```bash
cd ~/mehtamart && git pull && cd deploy && docker compose up -d --build
# wait ~15 s, then:
curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:8100/health   # 200
```
A `000` right after a restart is normal; wait and check again.

**Logs and restart:**
```bash
cd ~/mehtamart/deploy
docker compose logs web --tail 30
docker compose restart web
```

**Give or remove admin rights.** The person signs up on the site first. This stops the app for a few seconds:
```bash
cd ~/mehtamart/deploy
docker compose stop web && docker compose run --rm web npm run role -- 98XXXXXXXX admin && docker compose start web
# use "customer" to remove the rights, or "list" to see admins
```

**Backup:** see `DEPLOY.md`. It stops `web`, then tars the `mehtamart_data` volume to `~/backups`.

**Rules on this shared VM** (from the user's DEPLOYMENT-GUIDE.md):
- Only touch the `mehtamart` project.
- Never stop or restart other projects' containers, and never edit other Caddy site files.
- Never publish on `0.0.0.0` or open new ports.
- **Never `docker compose down -v`** (it deletes the data) and never `docker system prune -a`.
- Secrets live only in `.env` on the VM, never in git or chat.
- Other sites on the VM: service bot `https://VM-IP-DASHED.sslip.io` (port 8080) and alerts `https://alerts.VM-IP-DASHED.sslip.io` (port 8000).

**Local development:** `npm install`, `cp .env.example .env`, `npm start` (port 3000), `npm test`.

## 9. Timeline and problems already solved

1. **First DM proof of concept:** Meta app with Instagram login, webhook verified. Fixes:
   - Make the Codespace port Public.
   - Use the right one of the two app secrets.
   - Comment from `_squenza`, not the business account (`skip:own-comment`).
   - Make the DM link clickable with the button template.
2. **Per-reel stores and admin panel,** with Postgres/PGlite. Upgraded to Express 5 for async errors. Fixed a cart.js TDZ bug and `[hidden]` CSS overrides.
3. **Mehta Mart demo data** (3 reels × 12 products), the full-store home page, and the "Open in Chrome" prompt with the bag carried across.
4. **Approved design samples, then the full build:** storefront, Reels tab, accounts, owner tools, Docker deployment files. Docker image built and tested (~260 MB RAM).
5. **Full catalog scrape** (13 categories, 178 products).
6. **Deployed to the VM.** SSH timed out on the office network and worked from another network. Meta webhook switched to the VM. Demo data loaded.
7. **Changes after launch:**
   - Login required to check out.
   - Admin rights only via the role command.
   - Desktop header icons moved to the right.
   - Browsers kept using the old CSS after an update, fixed with asset fingerprints (`?v=`).

## 10. Known gaps and next steps

- **Real payments:** Razorpay or Cashfree checkout, plus a payment webhook that marks orders as paid.
- **Meta App Review** (Advanced Access) so everyone, not just Instagram testers, gets DMs.
- **Token refresh:** the long-lived token expires after 60 days. Add automatic refresh (`GET /refresh_access_token`) or put a reminder in the calendar.
- **Own domain** instead of sslip.io: add a DNS A record to VM-IP, then run `add-site.sh ... --host`.
- **Password reset by SMS/OTP** instead of the owner resetting it.
- **Admin role changes without downtime:** add an admin-only UI, or move to a hosted Postgres so the CLI can run alongside the app.
- **Owner notification for new orders** (WhatsApp or email).
- **Deep links:** `/reels#<slug>` only finds reels in the first batch of 8.
- **Plant Store plugin:** keep the 4 Mehta Mart reels (toys, kitchen, cleaning, bedsheets) here and the plant reels in the plugin. When the Instagram token is renewed, update it in both `~/mehtamart/deploy/.env` and `~/plantstore-dm/deploy/.env`.
- **Port register:** record 8100 → `mehtamart` in DEPLOYMENT-GUIDE.md and `infra/oracle-vm/README.md` (still to do).
- **Demo data:** some Mehta Mart prices show very large discounts (e.g. 94% off). That's their data; edit it in Admin if needed.

## Start here (paste into a new chat)

> I'm continuing a project. Repo `Shashank-Codes-bit/Auto_DM`, branch `claude/affectionate-rubin-it8bkq`. Read `HANDOFF.md`, `README.md` and `DEPLOY.md` first. It's an Instagram comment → DM → per-reel shoppable store, demoed as a full store for Mehta Mart, live on my Oracle VM at https://mehtamart.VM-IP-DASHED.sslip.io (Docker, port 8100, Caddy in front, built-in PGlite database in a Docker volume). Develop on the same branch, run `npm test` before pushing, and never put secrets in git or chat. I update the VM with: `cd ~/mehtamart && git pull && cd deploy && docker compose up -d --build`. Next I want to: <your next task>.
