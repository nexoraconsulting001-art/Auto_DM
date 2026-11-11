# One image, two processes: "node src/server.js" (web) and "node src/worker.js" (background jobs).
# Runs on the Oracle Arm64 VM and on amd64 clouds (node:22-slim is multi-arch).

# The repository also holds the mobile apps (apps/*, packages/*), on the same lockfile. Both installs below name the
# server's workspaces only, so React Native and Expo are never downloaded here, and .dockerignore keeps the apps'
# source out of the image.

# The seller console is built here; only its static files reach the final image.
FROM node:22-slim AS console
WORKDIR /app
COPY package*.json ./
COPY console/package.json console/
COPY shared/api-client/package.json shared/api-client/
RUN npm ci --workspace @bhava/console --workspace @bhava/api-client --include-workspace-root
COPY console console
COPY shared shared
COPY src/contracts src/contracts
RUN npm run build:console

FROM node:22-slim
# pg_dump and pg_restore for backups, matching the Postgres 16 server.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY console/package.json console/
COPY shared/api-client/package.json shared/api-client/
RUN npm ci --omit=dev --workspace @bhava/console --workspace @bhava/api-client --include-workspace-root
COPY . .
COPY --from=console /app/console/dist console/dist
RUN test ! -e node_modules/react-native && test ! -e node_modules/expo && test ! -e apps && test ! -e packages
ENV NODE_ENV=production
ENV STORAGE_DIR=/data/files
# The app runs as a non-root user; named volumes take their owner from this folder.
RUN mkdir -p /data/files && chown -R node:node /data
USER node
CMD ["node", "src/server.js"]
