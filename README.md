# Auto DM: shoppable reels for Instagram

> Picking up this project in a new chat? Start with [HANDOFF.md](HANDOFF.md): full context, decisions, deployment and next steps.

Someone comments a keyword on one of your reels. They get a DM with a **Shop now** button. The button opens a store page that shows only the 1–20 products from **that reel**. They add items to their bag and check out, and the order lands in your admin panel.

```
comment "LINK" on a reel ──▶ webhook ──▶ DM with "Shop now" button
                                              │
                                              ▼
                         /r/<reel-store>  (1–20 products from that reel)
                                              │  bag → checkout (address)
                                              ▼
                         /order/<id>  pay by UPI QR ──▶ order in /admin
```

It uses Instagram's official APIs: comment **webhooks**, plus **Private Replies**, which let you DM the person who wrote a comment. Instagram allows one private reply per comment, sent within 7 days of the comment.

> **Payments are a demo for now.** The checkout shows a UPI QR with the order amount, but it isn't connected to a payment gateway. The shopper taps “I've paid”, and you confirm the payment in the admin panel.

## What's inside

One website for shoppers and the store owner. What you see depends on who's logged in.

| Part | Where | What it does |
|---|---|---|
| Home | `/` | Hero with today's top deal, categories, price chips, reels with Shop now, best deals, trust points, bulk-order banner |
| Shop | `/shop`, `/c/<category>` | Search, category chips, and a Filter & sort sheet (price band, sort). Filters stay in the link |
| Product | `/p/<slug>` | Photo gallery, price with MRP and % off, description, "You may also like", sticky Add to bag |
| Reels | `/reels` | Full-screen reels that snap one by one like Instagram. The one on screen plays muted (tap for sound), more load as you scroll, and Shop now opens that reel's store |
| Reel store | `/r/<slug>` | Where the DM button lands: only that reel's 1–20 products, in the order they appear |
| Checkout and payment | `/checkout`, `/order/<token>` | Needs a login. Address form (filled in from the last order), then a "Pay with UPI app" button, a UPI QR and order progress |
| Accounts | `/login`, `/signup`, `/account` | Phone + password. My account shows orders, the saved address and a password change |
| Admin panel | `/admin` | Owner only: Dashboard, Orders, Products, Categories, Reels, Customers, DM activity, Settings |
| Webhook | `/webhook` | Receives Instagram comments and sends the DM |

**Who sees what:**
- **Everyone** can browse the store, the reels and the reel stores the DM links open, without logging in.
- **Shoppers** need an account to place an order. Tapping Checkout as a guest opens the login page (with "Create an account"), then goes straight back to checkout with the bag kept.
- **Every new signup is a customer.** Nothing on the website can give admin rights.
- **The owner** logs in on the same `/login` page with `ADMIN_PHONE` and `ADMIN_PASSWORD` from `.env`, and is made admin on every start.
- **More admins** are added on the server with the role command (below). They sign up on the website first and keep their own password.
- **Admins** get a slim owner bar on every store page with an "Edit this page" link, and Edit buttons on products, categories and reels. Customers who try to open `/admin` are sent to their account page.

### Giving someone admin rights

Run this on the server. It works on accounts that already signed up:

```bash
npm run role -- list                  # who is an admin
npm run role -- 9876543210 admin      # make them an admin
npm run role -- 9876543210 customer   # back to a normal shopper
```

With the built-in database, only one process can open it at a time, so stop the app for a moment. On the Oracle VM:

```bash
cd ~/mehtamart/deploy
docker compose stop web && docker compose run --rm web npm run role -- 9876543210 admin && docker compose start web
```

The `ADMIN_PHONE` owner can't be turned into a customer; change `.env` instead.

Admin panel sections:
- **Dashboard:** a setup checklist that ticks itself off (connect Instagram, store details, products, first reel store, first comment, first order). Then DMs sent, store visits, orders and revenue, per-reel numbers, and orders waiting for you.
- **Products:** one shared catalog. Each product has a name, description, price and MRP, up to 6 photos (upload or paste a link), one option such as Size, stock, categories, a Featured switch (shows in "Today's best deals"), and an archive switch.
- **Categories:** add, edit, hide and reorder categories, each with an image.
- **Reels:** your Instagram posts, fetched live. For each reel, pick 1–20 products and set the order. Also set the headline, store link, keywords, DM text, button text, public reply, and live or paused.
- **Orders:** filter and search. Move an order through Awaiting payment, Payment submitted, Paid, Shipped and Delivered, or cancel it (cancelling puts the stock back). There's also a link to WhatsApp the customer.
- **Customers:** shopper accounts with order counts and spend. There's no SMS service, so a forgotten password is reset here: the owner gets a new password to send on WhatsApp.
- **DM activity:** every comment the webhook received, and what happened to it.
- **Settings:** store name, logo, home page and About page text, trust points, GSTIN, delivery fee, free-delivery threshold, UPI ID shown on the QR, and support contacts. Also shows the Instagram connection status.

## Run it (GitHub Codespaces or your computer)

Requirements:
- Node.js 20 or newer.
- An Instagram **Business or Creator** account, connected to a Meta app with **Instagram login**. The app needs the `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages` permissions.

Steps:
1. Install and configure:
   ```bash
   npm install
   cp .env.example .env
   ```
2. Fill in `.env`:
   - `IG_ACCESS_TOKEN`, `IG_USER_ID`, `APP_SECRET`, `VERIFY_TOKEN`: from the Meta app.
   - `ADMIN_PHONE` and `ADMIN_PASSWORD`: the owner's login. The account is created on start.
   - `SESSION_SECRET`: a long random string, so logins survive restarts.
   - `PUBLIC_BASE_URL`: the public address of the server. In Codespaces, that's the port-3000 address, e.g. `https://xxxx-3000.app.github.dev`.
   - `DATABASE_URL`: leave empty to use the built-in database stored in `data/pgdata`.
3. Start the server:
   ```bash
   npm start
   ```
   In Codespaces, set port 3000 to **Public** in the Ports tab.
4. Point Meta at it. In the Meta app, open Instagram → API setup with Instagram login → **Configure webhooks**:
   - **Callback URL:** `PUBLIC_BASE_URL/webhook`
   - **Verify token:** your `VERIFY_TOKEN`
   - Subscribe to **comments**, and switch on the webhook subscription for your account.
5. Open `PUBLIC_BASE_URL/login` and log in with `ADMIN_PHONE` and `ADMIN_PASSWORD`. You land on the Dashboard, where the setup checklist walks you through the rest:
   1. **Settings:** set your store name, logo and delivery fee.
   2. **Categories** and **Products:** add your catalog.
   3. **Reels:** pick a reel, then **Set up store**. Choose its products and keyword, and save.
6. From a tester account, comment the keyword on that reel. You'll get the DM, the button opens the store, and an order placed there shows up in **Orders**.

While the Meta app hasn't passed App Review, only accounts with a role on the app trigger webhooks and receive DMs. Add your test account under **App roles → Roles → Instagram tester**.

## Demo data (Mehta Mart)

`seed/mehtamart.json` holds real data from mehtamartmhm.com: their collections as categories (with images), products with names, prices, MRPs, descriptions and photo links, plus store text for the home and About pages. The biggest discounts are marked Featured. It also sets up stores for your **3 newest reels**. Load it in either of two ways:
- **Admin → Settings → Load demo data** (no restart needed), or
- `npm run seed` while the server is **stopped**. To choose the reels yourself, run `npm run seed -- <newest> <second> <third>`.

| Reel | Store | Keywords |
|---|---|---|
| Newest | Kitchen Creations, `/r/kitchen-creations` | `KITCHEN`, `LINK` |
| 2nd | Fresh Start Cleaning, `/r/fresh-start-cleaning` | `CLEAN`, `LINK` |
| 3rd | Trending Toys, `/r/trending-toys` | `TOYS`, `LINK` |

It's safe to run again: categories and products are matched by name and reused. Store settings you've already changed are kept.

## Instagram's in-app browser

The DM button opens the store inside Instagram's own browser, and shoppers can finish everything there. Store pages also offer a way out to the phone's real browser:
- **End-of-page button:** an "Open full store in Chrome" button (Safari on iPhone) at the bottom of every store page. It's always there.
- **Floating card:** the same offer appears in a card once the shopper scrolls to the bottom. It stays until they tap ✕ or the button, and shows once per session.
- **Bag carried over:** the bag travels in the link (`/shop?bag=…`) and is restored in the other browser.
- **Only inside Instagram or Facebook:** none of this shows in a normal browser. To preview it anyway, add `?preview_inapp=1` to a store URL.

On Android this uses a Chrome intent link. On iPhone it uses `x-safari-https://` (iOS 17+). If that does nothing, the card tells the shopper to use ⋯ → "Open in external browser".

## Behaviour notes

- Every keyword comment gets a DM. Set `ONE_DM_PER_USER=1` to limit each person to one DM per reel. Keyword matching ignores case and only counts whole words.
- If Meta delivers the same comment twice, it gets one DM. Comments from your own account never get a DM.
- The DM uses a button template. If Instagram rejects it, the DM is sent as plain text with the link.
- Prices, delivery and stock are always recalculated on the server at checkout. Stock is reserved when an order is placed and restored if the order is cancelled.
- `DRY_RUN=1` logs DMs instead of sending them.

## Hosting

- **Oracle VM (Docker + Caddy):** see [DEPLOY.md](DEPLOY.md). `Dockerfile` and `deploy/compose.yaml` run the store on `127.0.0.1:8100` with its data in a Docker volume, at `https://mehtamart.VM-IP-DASHED.sslip.io`. Health check: `/health`.
- Any other Node host with HTTPS works too: Render, Railway, Fly.io. A `render.yaml` is included.
- Use a hosted Postgres for `DATABASE_URL`, for example the free tier of [Neon](https://neon.tech) or [Supabase](https://supabase.com). On free Render the disk is wiped on every deploy, so the built-in database would lose its data. Uploaded photos are stored in the database too.
- Set `PUBLIC_BASE_URL` to the hosted address, and update the webhook URL in Meta.

## Tests

```bash
npm test
```

## Next steps

- **Real payments:** Razorpay or Cashfree checkout, plus a payment webhook that marks orders as paid.
- **App Review:** Meta App Review (Advanced Access) so that everyone, not just testers, gets DMs.
- **Token refresh:** long-lived tokens expire after 60 days. Refresh them automatically with `GET /refresh_access_token`.
