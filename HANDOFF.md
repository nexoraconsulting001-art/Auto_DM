# Bhava handoff

Bhava is a white-label platform for Instagram and Facebook commerce. Many businesses run on one codebase and one database, and every business is onboarded the same way: there is never code for one client.

The requirements (PRD) and build plan live outside this repo, because the repo is public. Work happens on `bhava/build`.

## Rules that never bend

- Every business-owned row has `tenant_id`; every business repo calls `tenantId()` and refuses to run without one. New tables get `tenant_id` and composite foreign keys.
- Everything a seller uses is Bhava-branded; everything a buyer sees is the seller's brand. No Bhava text in DMs.
- Nothing sends to Instagram, Facebook or WhatsApp except through the compliance gate once it exists.
- No usernames, message text or phone numbers in logs. Money is integer paise.
- DM links are direct: no Bhava redirect or shortener.

## Where things are

| Path | What it is |
|---|---|
| `src/server.js`, `src/worker.js` | The web app and the background worker. Both refuse to start without `DATABASE_URL`, unless `NODE_ENV=test` or `ALLOW_PGLITE=1` |
| `src/tenancy.js` | The current business (`withTenant`, `tenantId`) and finding it from the web address |
| `src/modules/index.js` | The module registry: new features go in `src/modules/<name>` and are listed here |
| `src/repos` | Data access for the core tables |
| `src/platform` | Switchable drivers: storage, queue, analytics, cache, metrics, secrets, log |
| `src/adapters`, `src/contracts` | Real connections to outside services; shared schemas and interfaces |
| `src/contracts/api` | The seller API at `/api/v1`, as zod schemas and a route table |
| `shared/api-client` | The client for that API, used by the console and later the owner app |
| `console` | The seller console: React and Vite, built to `console/dist` with `npm run build:console` |
| `src/db/migrations` | `NNN_name.sql`, applied in order on start |
| `tools/gate.mjs` | `npm run gate -- N`: every test for phases 0 to N on a fresh Postgres |
| `deploy/bhava` | QA on the shared VM, port 8140. See its README |

## Interfaces other work builds on

**Modules** (`src/modules/index.js`): an object with a `name` and any of `repos`, `beforeTenant`, `routes`, `platformRoutes`, `api`, `jobs`. List it in `MODULES`; `createApp`, `createRepos` and `registerJobs` do the rest.

**Seller API** (`src/contracts/api`): `routes` is the table of every `/api/v1` route, with its method, path, `access`, zod schemas for input and output, and success status. The router in `src/modules/api-v1` is built from it. A module answers routes with `api(ctx)` returning `{ 'products.get': async ({ params, query, body, file, user, req, res }) => result }`. Returning null is a 404; throw `ApiError(code, message)` to refuse, and a repo's `ValidationError` becomes a 400. A route nobody answers is a 501. Results are parsed through the response schema, so a field not in the schema never leaves the server. Every failure is `{ error, code, fields?, requestId? }`. Lists take `cursor` and `limit` and return `{ items, nextCursor }`. A new route goes in the contract first, with its method added to `shared/api-client/index.js`; a test keeps the two in step.

**Access** (`src/contracts/api/access.js`): each route names `PUBLIC`, `SIGNED_IN`, `OWNER_ONLY`, `MANAGERS` or `staffWith(permission)`. The manager role and staff permissions are not stored yet, so today only owners pass the seller routes and staff are refused. Refusals and lookups that find nothing are logged with ids only.

**Seller console** (`console`): at `/admin` on each business's address when `ADMIN_UI=console`; anything else keeps the old server-rendered pages, which existing tests still cover, until the console replaces them. A feature is `console/src/features/<name>/index.jsx` and registers itself: see `console/src/features/index.js`. Components and tokens are in `console/src/design`; the API client is `api` from `console/src/lib/api`. The console signs in with a cookie session (`transport: 'cookie'`), and the client sends the CSRF token for you.

**Brand kit** (`repos.brandKit`): `get()` returns `{ preset, presetName, logoUrl, logoDarkUrl, faviconUrl, colors, headingFont, bodyFont }`; `save(partial)` validates colours, the 4.5:1 primary and on_primary contrast and the font allow-list; `presets()` lists the looks. Presets are rows in `theme_presets`, with the codes `utsav`, `dewdrop`, `tadka`, `gadget-galli` and `mitti`. Buyer pages use `buyerSettings(repos)` from `src/modules/brand`, and `brandCss` and `brandFontsHref` from its `theme.js`.

**Entitlements** (`repos.entitlements`): `can(feature)` is true or false; `limit(feature)` is a number, `Infinity` for no limit, or 0 when not included; `setOverride(feature, { enabled, limit })`, `clearOverride(feature)`. Plans are in `plan_features`, per-business changes in `tenant_features`. A `tenant_features` row replaces the plan's row for that feature. Features seeded: `automations`, `dms.monthly`, `insights.days`, `reel.products`, `triggers.comment`, `triggers.story_dm`, `links.two_tap`, `links.one_tap`, `store.checkout`, `app.android`, `app.ios` and others in migration 004.

**Roles.** Business users are `owner`, `staff` or `customer`; `auth.requireRole(...roles)` guards a route. `/admin` is owner-only until staff permissions exist. Bhava's team are `platform_users` (`super_admin`, `support`): they sign in with `POST /login` on the platform host (`PLATFORM_HOST`, by default `admin.<PLATFORM_DOMAIN>`) and `requirePlatformRole(...roles)` from `src/auth.js` guards their routes. Add one with `npm run platform-user`.

**Instagram** (`src/instagram.js`): `createInstagram(config)` gives a client whose calls take the account first, for example `sendPrivateReply(account, commentId, text)`, where `account` is `{ igUserId, token }` from `repos.igAccounts` (`get(igUserId)`, `current()`, `setToken(igUserId, token)`). `forAccount(client, account)` binds one account. `GRAPH_BASE_URL` points it at a simulator. Tokens are encrypted with `DATA_KEY`.

**Bearer sessions.** `POST /api/v1/auth/login` on a business's address, with `{ phone, password }` and no `transport`, returns a token. Afterwards `Authorization: Bearer <token>` sets the user and the business, before and regardless of the web address, and CSRF does not apply. A bad token gets 401. `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`. Access tokens and refresh rotation (PRD 10.2) are not built yet: a token lasts 30 days.

**Logs**: `log.info('name', { ids only })` from `src/platform/log.js`. `src` has no console calls.
