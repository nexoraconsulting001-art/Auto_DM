# Bhava

A white-label platform for Instagram and Facebook commerce: comment-to-DM automation, per-reel landing pages, a store, and branded apps, for many businesses on one codebase. Sellers see Bhava; shoppers see only the seller.

Start with [HANDOFF.md](HANDOFF.md) for how the code is organised and the rules it follows.

## Run it

Needs Node 22.

```bash
npm install
cp .env.example .env     # set DATABASE_URL, or ALLOW_PGLITE=1 for a quick local run
npm start                # the web app
npm run worker           # background jobs (needs Postgres when the web app is also running)
```

```bash
npm run tenant -- create <slug> "<Business name>"
npm run platform-user -- list
```

## Test it

```bash
npm test                 # everything, on an in-memory database
npm run gate -- 0        # everything for phase 0, on a fresh Postgres, with the phase rules
npm run secret-scan      # before any push: the repo is public
```

## Deploy

QA runs on a shared VM with Docker Compose: see [deploy/bhava/README.md](deploy/bhava/README.md).
