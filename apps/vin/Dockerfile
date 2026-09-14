FROM node:24.21.0-bookworm-slim AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH="/pnpm:$PATH" \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN npm install --global --ignore-scripts pnpm@10.34.5
WORKDIR /app

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.json ./
COPY patches ./patches
COPY packages/core ./packages/core
COPY packages/sources ./packages/sources
COPY apps/vin ./apps/vin
RUN pnpm install --frozen-lockfile && pnpm build:vin

FROM base AS production-dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY packages/core/package.json ./packages/core/package.json
COPY packages/sources/package.json ./packages/sources/package.json
COPY apps/vin/package.json ./apps/vin/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AUTODOM_VIN_API_HOST=0.0.0.0 \
    AUTODOM_VIN_API_PORT=8080
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/vin/dist ./apps/vin/dist
COPY package.json ./package.json
RUN groupadd --gid 10001 autodom \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin autodom \
    && install -d -m 0700 -o 10001 -g 10001 /var/lib/autodom-vin
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 CMD ["node", "apps/vin/dist/cli.js", "health"]
ENTRYPOINT ["node", "apps/vin/dist/cli.js"]
CMD ["serve"]
