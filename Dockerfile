FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
WORKDIR /app

FROM base AS dependencies
# better-sqlite3 11 needs a compiler when no Node 24 prebuild is available.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci \
    && node -e "const Database = require('better-sqlite3'); new Database(':memory:').close()"
COPY frontend-vite/package.json frontend-vite/package-lock.json ./frontend-vite/
RUN npm ci --prefix frontend-vite \
    && node -e "require('./frontend-vite/node_modules/esbuild').transformSync('const ok = 1')"

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY frontend-vite ./frontend-vite
RUN npm run buildall

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev \
    && node -e "const Database = require('better-sqlite3'); new Database(':memory:').close()"

FROM base AS runtime
ENV NODE_ENV=production \
    SQLITE_TMPDIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
COPY package.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/frontend-vite/dist ./frontend-vite/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz', { signal: AbortSignal.timeout(4000) }).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.js"]
