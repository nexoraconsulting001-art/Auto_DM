# syntax=docker/dockerfile:1.7
#
# One image recipe, two targets (Phase 9, G-01):
#   docker build --target web    -t bhava-web .      node src/server.js   (the default: the last stage)
#   docker build --target worker -t bhava-worker .   node src/worker.js
# Both hold the same files; only the command, the exposed port and the health check differ.
#
# - The base is pinned to an exact Node release. To pin its digest too, pass it at build time:
#     --build-arg NODE_IMAGE=node:22.17.0-bookworm-slim@sha256:<digest>
# - Multi-arch: Node's slim images are published for linux/amd64 and linux/arm64, and nothing below is arch-specific:
#     docker buildx build --platform linux/amd64,linux/arm64 --target web -t <registry>/bhava-web:<tag> --push .
# - Production dependencies only: the installs name the server's workspaces, so React Native and Expo are never
#   downloaded, and dev tools (test runners, bundlers, linters) are omitted. .dockerignore keeps the apps, the tests,
#   the docs and the simulators (tools/sim, apart from the guard the adapters import) out of the build context.
#   The deps guard looks for an installed package (its package.json), not a folder: npm leaves an empty scope folder
#   such as node_modules/@playwright behind for an omitted scoped dev package.
# - A non-root user (node, uid 1000) that owns nothing in /app: run it with a read-only root file system and a
#   writable /tmp (compose: read_only + tmpfs; Kubernetes: readOnlyRootFilesystem + an emptyDir at /tmp).
# - tini is PID 1, so SIGTERM reaches node and the drain in src/platform/health.js runs within SHUTDOWN_SECONDS.
# - The QA compose file (deploy/bhava) builds the default target and sets each service's command; it still works.

ARG NODE_IMAGE=node:22.17.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /app

# ---- the seller console and the Platform Console: built here, only their static files reach the final image ----------
FROM base AS console
COPY package.json package-lock.json ./
COPY console/package.json console/
COPY shared/api-client/package.json shared/api-client/
RUN npm ci --include=dev --workspace @bhava/console --workspace @bhava/api-client --include-workspace-root
COPY console console
COPY shared shared
COPY src/contracts src/contracts
RUN npm run build:console

# ---- production dependencies of the server only ----------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY console/package.json console/
COPY shared/api-client/package.json shared/api-client/
RUN npm ci --omit=dev --workspace @bhava/console --workspace @bhava/api-client --include-workspace-root \
  && npm cache clean --force \
  && for p in react-native expo @expo vite jest playwright @playwright eslint typescript; do \
       for f in "node_modules/$p/package.json" node_modules/$p/*/package.json; do \
         if [ -e "$f" ]; then echo "a dev or app package reached the image: $p"; exit 1; fi; \
       done; \
     done

# ---- what both targets share -------------------------------------------------------------------------------------------
FROM base AS runtime
# tini forwards signals to node; pg_dump and pg_restore (matching Postgres 16) are for the backup job and the data move.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/*
COPY --from=deps /app/node_modules node_modules
COPY . .
COPY --from=console /app/console/dist console/dist
COPY --from=console /app/console/dist-platform console/dist-platform
# The image holds the server and nothing else: no app source, no tests, no simulators (only the guard that refuses them).
RUN test ! -e apps && test ! -e packages && test ! -e test && test ! -e e2e && test ! -e docs \
  && test -f tools/sim/guard.mjs && test ! -e tools/sim/index.mjs && test ! -e tools/sim/meta \
  && node --check src/server.js && node --check src/worker.js \
  && mkdir -p /data/files && chown node:node /data/files
# npm keeps its cache and logs under /tmp, the one writable folder. /data/files is only the QA compose file's local
# storage volume; production uses object storage.
ENV STORAGE_DIR=/data/files \
    NPM_CONFIG_CACHE=/tmp/.npm \
    PORT=3000 \
    WORKER_HEALTH_PORT=3001
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]

# ---- the worker: background jobs, health on WORKER_HEALTH_PORT ---------------------------------------------------------
FROM runtime AS worker
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/worker.js"]

# ---- the web server (the default target) -------------------------------------------------------------------------------
FROM runtime AS web
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.js"]
