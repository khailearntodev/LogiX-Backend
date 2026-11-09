# syntax=docker/dockerfile:1.7
#
# One-shot tooling image: Prisma migrations for the 8 NestJS services and the
# demo seed script. Contains the FULL workspace (dev deps, prisma CLI) and is
# never used to serve traffic. Build context MUST be the repository root.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim
ENV CI=true \
    PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl postgresql-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.6.0 \
 && pnpm config set minimum-release-age 0
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY libs/auth/package.json libs/auth/
COPY libs/cache/package.json libs/cache/
COPY libs/common/package.json libs/common/
COPY libs/config/package.json libs/config/
COPY libs/database/package.json libs/database/
COPY libs/errors/package.json libs/errors/
COPY libs/logger/package.json libs/logger/
COPY libs/messaging/package.json libs/messaging/
COPY apps/identity-service/package.json apps/identity-service/
COPY apps/master-data-service/package.json apps/master-data-service/
COPY apps/order-service/package.json apps/order-service/
COPY apps/inventory-service/package.json apps/inventory-service/
COPY apps/fulfillment-service/package.json apps/fulfillment-service/
COPY apps/transport-service/package.json apps/transport-service/
COPY apps/notification-service/package.json apps/notification-service/
COPY apps/audit-service/package.json apps/audit-service/
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.minimum-release-age=0 \
      --filter identity-service --filter master-data-service --filter order-service \
      --filter inventory-service --filter fulfillment-service --filter transport-service \
      --filter notification-service --filter audit-service

# Only what migrations and the seed need (prisma/, prisma.config.ts, scripts/).
COPY apps/identity-service/prisma.config.ts apps/identity-service/
COPY apps/identity-service/prisma apps/identity-service/prisma/
COPY apps/master-data-service/prisma.config.ts apps/master-data-service/
COPY apps/master-data-service/prisma apps/master-data-service/prisma/
COPY apps/order-service/prisma.config.ts apps/order-service/
COPY apps/order-service/prisma apps/order-service/prisma/
COPY apps/inventory-service/prisma.config.ts apps/inventory-service/
COPY apps/inventory-service/prisma apps/inventory-service/prisma/
COPY apps/fulfillment-service/prisma.config.ts apps/fulfillment-service/
COPY apps/fulfillment-service/prisma apps/fulfillment-service/prisma/
COPY apps/transport-service/prisma.config.ts apps/transport-service/
COPY apps/transport-service/prisma apps/transport-service/prisma/
COPY apps/notification-service/prisma.config.ts apps/notification-service/
COPY apps/notification-service/prisma apps/notification-service/prisma/
COPY apps/audit-service/prisma.config.ts apps/audit-service/
COPY apps/audit-service/prisma apps/audit-service/prisma/
COPY scripts ./scripts
COPY infrastructure/docker/scripts ./infrastructure/docker/scripts
RUN find infrastructure/docker/scripts -name '*.sh' -exec sed -i 's/\r$//' {} +

CMD ["sh", "infrastructure/docker/scripts/migrate-node.sh"]
