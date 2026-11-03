# syntax=docker/dockerfile:1.7
#
# Production-ready generic image for NestJS services in the pnpm monorepo.
# Uses a single unified dependency cache stage so pnpm install runs EXACTLY ONCE
# for the whole monorepo, completely eliminating store lock contention.

ARG NODE_VERSION=22

# ---------------------------------------------------------------- base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.6.0 \
 && pnpm config set minimum-release-age 0
WORKDIR /repo

# ---------------------------------------------------------------- deps
# Copies workspace manifests and installs dependencies ONCE for the whole monorepo.
# Notice: NO `ARG SERVICE` here! This stage is cached and reused across all 9 services.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY libs/auth/package.json libs/auth/
COPY libs/common/package.json libs/common/
COPY libs/config/package.json libs/config/
COPY libs/database/package.json libs/database/
COPY libs/errors/package.json libs/errors/
COPY libs/logger/package.json libs/logger/
COPY libs/messaging/package.json libs/messaging/
COPY apps/api-gateway/package.json apps/api-gateway/
COPY apps/identity-service/package.json apps/identity-service/
COPY apps/master-data-service/package.json apps/master-data-service/
COPY apps/order-service/package.json apps/order-service/
COPY apps/inventory-service/package.json apps/inventory-service/
COPY apps/fulfillment-service/package.json apps/fulfillment-service/
COPY apps/transport-service/package.json apps/transport-service/
COPY apps/notification-service/package.json apps/notification-service/
COPY apps/audit-service/package.json apps/audit-service/

RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.minimum-release-age=0

# --------------------------------------------------------------- build
# Compiles libraries, Prisma client, and the target service.
FROM deps AS build
ARG SERVICE
COPY libs ./libs
COPY apps/${SERVICE} ./apps/${SERVICE}

# 1) Build internal workspace libraries
RUN pnpm --filter "${SERVICE}^..." build

# 2) Generate Prisma client if schema exists
RUN if [ -f "apps/${SERVICE}/prisma/schema.prisma" ]; then \
      DATABASE_URL="postgresql://build:build@localhost:5432/build" \
      pnpm --filter "${SERVICE}" db:generate; \
    fi

# 3) Build the service itself
RUN pnpm --filter "${SERVICE}" build

# ------------------------------------------------------------- runtime
FROM base AS runtime
ARG SERVICE
ARG PORT=3000
ENV NODE_ENV=production \
    PORT=${PORT}

WORKDIR /app

# Copy root workspace structure and dependencies from the single cached deps stage
COPY --from=deps --chown=node:node /repo/package.json ./package.json
COPY --from=deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=deps --chown=node:node /repo/libs ./libs
COPY --from=build --chown=node:node /repo/libs ./libs
COPY --from=deps --chown=node:node /repo/apps/${SERVICE}/package.json ./apps/${SERVICE}/package.json
COPY --from=build --chown=node:node /repo/apps/${SERVICE}/dist ./apps/${SERVICE}/dist

WORKDIR /app/apps/${SERVICE}
USER node
EXPOSE ${PORT}

# Healthcheck ensuring HTTP server is accepting connections
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
  CMD node -e "require('net').connect(process.env.PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
