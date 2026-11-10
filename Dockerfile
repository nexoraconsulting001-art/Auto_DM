# One image, two processes: "node src/server.js" (web) and "node src/worker.js" (background jobs).
# Runs on the Oracle Arm64 VM and on amd64 clouds (node:22-slim is multi-arch).
FROM node:22-slim
# pg_dump and pg_restore for backups, matching the Postgres 16 server.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV STORAGE_DIR=/data/files
# The app runs as a non-root user; named volumes take their owner from this folder.
RUN mkdir -p /data/files && chown -R node:node /data
USER node
CMD ["node", "src/server.js"]
