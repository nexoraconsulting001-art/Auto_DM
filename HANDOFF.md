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
| `src/adapters`, `src/contracts` | Real connections to outside services; shared schemas and interfaces. `src/adapters/meta` is everything that talks to Meta; `src/contracts/compliance.js` is the reason codes, limits and send interface |
| `src/contracts/api` | The seller API at `/api/v1`, as zod schemas and a route table |
| `shared/api-client` | The client for that API, used by the console and later the owner app |
| `console` | The seller console: React and Vite, built to `console/dist` with `npm run build:console` |
| `src/db` | The database handle (`openDb`) and `migrations`: `NNN_name.sql`, applied in order on start |
| `tools/gate.mjs` | `npm run gate -- N`: every test for phases 0 to N on a fresh Postgres |
| `deploy/bhava` | QA on the shared VM, port 8140. See its README |

## Interfaces other work builds on

**Modules** (`src/modules/index.js`): an object with a `name` and any of `repos`, `beforeTenant`, `routes`, `platformRoutes`, `api`, `jobs`. List it in `MODULES`; `createApp`, `createRepos` and `registerJobs` do the rest.

**Seller API** (`src/contracts/api`): `routes` is the table of every `/api/v1` route, with its method, path, `access`, zod schemas for input and output, and success status. The router in `src/modules/api-v1` is built from it. A module answers routes with `api(ctx)` returning `{ 'products.get': async ({ params, query, body, file, user, req, res }) => result }`. Returning null is a 404; throw `ApiError(code, message)` to refuse, and a repo's `ValidationError` becomes a 400. A route nobody answers is a 501. Results are parsed through the response schema, so a field not in the schema never leaves the server. Every failure is `{ error, code, fields?, requestId? }`. Lists take `cursor` and `limit` and return `{ items, nextCursor }`. A new route goes in the contract first, with its method added to `shared/api-client/index.js`; a test keeps the two in step.

**Access** (`src/contracts/api/access.js`): each route names `PUBLIC`, `SIGNED_IN`, `OWNER_ONLY`, `MANAGERS` or `staffWith(permission)`. Staff reach a route only through its named permission (`users.permissions`, set with `repos.users.setPermissions(id, list)` or `npm run role -- <phone> staff orders,catalog`). Refusals and lookups that find nothing are logged with ids only. There is no Team screen yet.

**One person, several businesses.** `X-Tenant-Id` on any `/api/v1` call asks to work in that business. It is checked against `memberships` on every call: not a member, or no such business, is a 403 with code `forbidden`, and a member becomes that person's account there, with that account's role and permissions. `GET /api/v1/auth/businesses` lists them for a switcher. A row in `memberships` is written only when the person proves both accounts are theirs, which with passwords means the same password opens both (`users.verify`). Never match on phone alone: an owner can type anyone's number onto a staff account. When one-time codes arrive (PRD 5.11), a verified phone becomes the proof.

**Row-level security.** Every table with a `tenant_id` has a policy (`tenant_fence`) that shows a transaction only the rows of `app.tenant_id`. `db.query`, `db.exec` and `db.tx` inside `withTenant()` run as the role `bhava_app` (not the owner, no superuser, no bypass) with `app.tenant_id` set for that transaction, so a query that forgets its `WHERE` still sees one business. Keep writing `WHERE tenant_id = $1` as well: the fence is the second lock, and the indexes need it. Outside `withTenant()`, and always through `db.platform.query/exec/tx`, work runs as the connection's own login with no fence. Use `db.platform` only for what is about no single business or has to look across them: routing a host or webhook to its business, the job queue, the Platform Console. `repos.tenants` and `repos.platformUsers` already do. The login in `DATABASE_URL` must own the tables, or be a superuser; migrations create `bhava_app` and make that login a member.

A new table, in a migration numbered for your phase:

```sql
CREATE TABLE widgets (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id integer NOT NULL,
  UNIQUE (tenant_id, id),                                                   -- so other tables can link to this one
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX widgets_product_idx ON widgets (tenant_id, product_id);
SELECT fence_tenant_table('widgets');                                       -- policy, grants, and its serial id
```

The foreign key carries `tenant_id`, so the database refuses a link to another business's row. For an insert-only table use `fence_tenant_table('widget_log', 'SELECT, INSERT')`. A table shared by every business with no `tenant_id`, such as `plans`, needs `GRANT SELECT ON x TO bhava_app`; a platform-only table needs no grant at all. With no grant, business code gets "permission denied", which is the point. A business may read only its own row of `tenants` and change only `next_order_number`; anything else on that table goes through `repos.tenants`. Backups keep privileges, and a restore creates the role first.

**Audit log** (`repos.audit`): `record({ actor, action, target, details })` adds a row for the current business, and `writeAudit(t, entry)` from `src/modules/audit` does it inside an open transaction, so the change and its row land together. `actor` is an id such as `user:12`. Details never hold secrets, tokens or usernames: mask first. Owners read it at `GET /api/v1/audit-log`.

**Payment keys** (`repos.gatewayKeys`): `save('razorpay', { keyId, keySecret }, actor)` encrypts the secret and writes the masked audit row in one transaction; `get('razorpay')` returns them decrypted, or null.

**Seller console** (`console`): at `/admin` on each business's address, whatever `ADMIN_UI` says; the old server-rendered pages are gone. Build it with `npm run build:console`. A feature is `console/src/features/<name>/index.jsx` and registers itself: see `console/src/features/index.js`. Components and tokens are in `console/src/design`; the API client is `api` from `console/src/lib/api`. The console signs in with a cookie session (`transport: 'cookie'`), and the client sends the CSRF token for you.

**Brand kit** (`repos.brandKit`): `get()` returns `{ preset, presetName, logoUrl, logoDarkUrl, faviconUrl, colors, headingFont, bodyFont, publicReplyVariants }`; `save(partial)` validates colours, the 4.5:1 primary and on_primary contrast, the font allow-list and the public replies (none, or 5 to 10 different ones of up to 150 characters, with no link, phone number or price); `presets()` lists the looks. Presets are rows in `theme_presets`, with the codes `utsav`, `dewdrop`, `tadka`, `gadget-galli` and `mitti`. Buyer pages use `buyerSettings(repos)` from `src/modules/brand`, and `brandCss` and `brandFontsHref` from its `theme.js`.

**Entitlements** (`repos.entitlements`): `can(feature)` is true or false; `limit(feature)` is a number, `Infinity` for no limit, or 0 when not included; `setOverride(feature, { enabled, limit })`, `clearOverride(feature)`. Plans are in `plan_features`, per-business changes in `tenant_features`. A `tenant_features` row replaces the plan's row for that feature. Features seeded: `automations`, `dms.monthly`, `insights.days`, `reel.products`, `triggers.comment`, `triggers.story_dm`, `links.two_tap`, `links.one_tap`, `store.checkout`, `app.android`, `app.ios` and others in migration 004.

**Roles.** Business users are `owner`, `manager`, `staff` or `customer`; `auth.requireRole(...roles)` guards a route. A business's status is `onboarding`, `active`, `paused`, `suspended` or `closed` (`killed` is also allowed). Bhava's team are `platform_users` (`super_admin`, `support`): they sign in with `POST /login` on the platform host (`PLATFORM_HOST`, by default `admin.<PLATFORM_DOMAIN>`) and `requirePlatformRole(...roles)` from `src/auth.js` guards their routes. Add one with `npm run platform-user`.

**Instagram** (`src/instagram.js`): `createInstagram(config)` gives a client whose calls take the account first, for example `getMedia(account, id)`, where `account` is `{ igUserId, token }` from `repos.igAccounts` (`get(igUserId)`, `current()`, `setToken(igUserId, token)`). `forAccount(client, account)` binds one account, and `await forBusiness(client, repos, igUserId?)` binds the current business's. Tokens are encrypted with `DATA_KEY`. It runs on the Meta adapter, so it has the same timeouts and host rules.

**Meta adapter** (`src/adapters/meta`, `ctx.meta`): `meta.client.forAccount(account)` for reads and setup (media, stories, comments, a person's profile, `subscribe`, ice breakers), and `meta.login` for connecting: `authorizeUrl({ state, redirectUri })`, `connect({ code, redirectUri })`, `refresh(token)`. `META_LOGIN` chooses Instagram Login or Unified Login behind that one interface, and scopes always come back in Instagram Login's names. `meta.facebookLogin` connects Pages. Every call has a 10 s timeout, follows no redirect and keeps the token out of the URL. `GRAPH_BASE_URL` points everything at a simulator, which is refused when `NODE_ENV=production`, and any host that isn't Meta's throws `api.host_blocked`. A failure is a `MetaApiError` with `kind` (`token_invalid`, `throttled`, `validation`, ...), `delivery` (`none` when Meta's answer proves nothing was delivered, `unknown` when it may have been: never resend those), `status`, `code`, `subcode` and `usage`. Provider callbacks use `verifyHubSignature` and `verifySignedRequest`, which return false or null on bad input and never throw.

**Compliance** (`src/modules/compliance`, `ctx.compliance`): the only path to Meta for a message. `send(action)` sends now, `enqueue(action)` creates the `outbound_jobs` row for the worker, `check(action)` applies the rules with no side effects. `action` and the result are in `src/contracts/compliance.js`, with the reason codes and every limit. Meta's refusals come back as a result with an `outcome` and `reason`; `send` throws only on an invalid action or with no current business. Nothing else may call `meta.client.sender` or the `ig` send calls, and a test enforces that. `repos.compliance.subjectHash(channel, personId)` is the only form of a person's id the log, blocklist and caps hold. A rule that refuses an API call throws `ApiError(code, message, { reason })`, and `reason` appears in the error body. **Until the compliance track fills it in, this is a stub that validates, sends and logs and applies no rules.** A module's `beforeTenant` runs before the Phase 0 webhook routes in `src/server.js`, so registering `POST /webhook` there replaces them.

**Between Phase 1 tracks.** The tables are the shared surface: webhook intake writes `inbound_events`, `inbox_threads`, `inbox_messages` and `needs_human_items`; the automations track reads them and owns `automations` and its children. Shared pure functions have one home each: `matchesKeywords` in `src/modules/automations/match.js`, `checkContent` and `fillTemplate` in `src/modules/compliance/content.js`, `directLink` and `linkProblem` in `src/modules/links/rules.js`. Import them from there and keep the signatures. Tell the owner or ops with `repos.alerts.raise({ kind, message, severity, target, dedupeKey, audience })`; email and push read that table when they are built. Addresses Meta and Caddy call are `PROVIDER_PATHS` and their shapes in `src/contracts/api/provider.js`.

**Phase 1 modules**: `ig-connect`, `compliance`, `automations` (also testers, ice breakers, the inbox), `links`, `facebook`, `domains`. Each answers its routes in `src/contracts/api` with `notBuilt(...)` (a 501) until the real handler replaces that id. Platform Console routes are in `platformRoutes` in `src/contracts/api/platform.js`. `channel` is `instagram` or `facebook`, and a table that belongs to one account has `ig_user_id` and `fb_page_id`, exactly one of them set, each with its own composite key. `ctx.config.facebookPages` is the flag for Facebook. Test against `createMeta` from `tools/sim/meta`: Facebook's controls are listed in `tools/sim/meta/facebook.mjs`.

**Bearer sessions.** `POST /api/v1/auth/login` on a business's address, with `{ phone, password }` and no `transport`, returns a token. Afterwards `Authorization: Bearer <token>` sets the user and the business, before and regardless of the web address, and CSRF does not apply. A bad token gets 401. `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`. Access tokens and refresh rotation (PRD 10.2) are not built yet: a token lasts 30 days.

**Logs**: `log.info('name', { ids only })` from `src/platform/log.js`. `src` has no console calls.
