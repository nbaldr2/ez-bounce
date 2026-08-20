# ---- stage 1: build the React app ----------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: build the server -------------------------------------------
FROM node:22-bookworm-slim AS server
WORKDIR /srv
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- stage 3: runtime ----------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server /srv/dist ./dist
COPY --from=web /web/dist ./web-dist

ENV WEB_DIST=/srv/web-dist \
    DATA_DIR=/data \
    UPLOAD_TMP_DIR=/data/tmp \
    PORT=3000

RUN mkdir -p /data/tmp && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
