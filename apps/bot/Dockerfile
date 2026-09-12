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
COPY packages/core ./packages/core
COPY packages/storage ./packages/storage
COPY apps/runtime ./apps/runtime
COPY apps/bot ./apps/bot
RUN pnpm install --frozen-lockfile && pnpm build:bot && pnpm build:runtime

FROM base AS production-dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY packages/core/package.json ./packages/core/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY apps/runtime/package.json ./apps/runtime/package.json
COPY apps/bot/package.json ./apps/bot/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    AUTODOM_BACKUP_DIR=/backups \
    AUTODOM_METRICS_PORT=9901 \
    AUTODOM_MINI_APP_HOST=0.0.0.0 \
    AUTODOM_MINI_APP_PORT=8080
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=build /app/packages/storage/migrations ./packages/storage/migrations
COPY package.json ./package.json
RUN groupadd --gid 10001 autodom \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin autodom \
    && mkdir /backups \
    && chown autodom:autodom /backups \
    && chmod 700 /backups
USER 10001:10001
EXPOSE 8080 9901
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["node", "apps/bot/dist/cli.js", "health"]
ENTRYPOINT ["node", "apps/bot/dist/cli.js"]
CMD ["serve"]
