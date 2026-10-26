FROM node:24.21.0-bookworm-slim AS base
ENV CI=true PNPM_HOME=/pnpm PATH="/pnpm:$PATH" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1
RUN npm install --global --ignore-scripts pnpm@10.34.5
WORKDIR /app

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.json ./
COPY patches ./patches
COPY packages/core ./packages/core
COPY packages/sources ./packages/sources
COPY apps/outreach ./apps/outreach
RUN pnpm install --frozen-lockfile && pnpm build:outreach

FROM base AS production-dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY packages/core/package.json ./packages/core/package.json
COPY packages/sources/package.json ./packages/sources/package.json
COPY apps/outreach/package.json ./apps/outreach/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production AUTODOM_OUTREACH_HOST=0.0.0.0 AUTODOM_OUTREACH_PORT=8092 AUTODOM_OUTREACH_INSTAGRAM_PYTHON=/opt/instagram/bin/python
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/outreach/requirements-instagram.txt /tmp/requirements-instagram.txt
RUN python3 -m venv /opt/instagram && /opt/instagram/bin/pip install --no-cache-dir --requirement /tmp/requirements-instagram.txt && rm /tmp/requirements-instagram.txt
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/outreach/dist ./apps/outreach/dist
COPY --from=build /app/apps/outreach/web ./apps/outreach/web
COPY --from=build /app/apps/outreach/instagram_worker.py ./apps/outreach/instagram_worker.py
COPY package.json ./package.json
RUN groupadd --gid 10001 autodom && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin autodom
USER 10001:10001
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 CMD ["node", "apps/outreach/dist/cli.js", "health"]
ENTRYPOINT ["node", "apps/outreach/dist/cli.js"]
CMD ["serve"]
