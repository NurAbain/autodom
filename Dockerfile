FROM node:24.21.0-bookworm-slim AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH="/pnpm:$PATH" \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN npm install --global --ignore-scripts pnpm@10.34.5
WORKDIR /app

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.json tsup.config.ts ./
COPY patches ./patches
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY packages/core/package.json ./packages/core/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/sources/package.json ./packages/sources/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/runtime/package.json ./apps/runtime/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AUTODOM_DATA_DIR=/data \
    AUTODOM_BACKUP_DIR=/backups \
    AUTODOM_METRICS_PORT=9901
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=build /app/packages/storage/migrations ./packages/storage/migrations
COPY package.json ./package.json
RUN groupadd --gid 10001 autodom \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin autodom \
    && mkdir /data /backups \
    && chown autodom:autodom /data /backups \
    && chmod 700 /data /backups
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=3 CMD ["node", "apps/runtime/dist/cli.js", "health"]
ENTRYPOINT ["node", "apps/runtime/dist/cli.js"]
CMD ["run"]
