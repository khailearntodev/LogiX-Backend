#!/bin/sh
# Applies Prisma migrations (`migrate deploy`, never `db push`) for every NestJS
# service. Runs as the one-shot `db-migrate` container; idempotent.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
HOST="${POSTGRES_HOST:-postgres}"
PORT="${POSTGRES_PORT:-5432}"
SSL_PARAM="${POSTGRES_SSL_PARAM:-}"

echo ">>> [db-migrate] Waiting for PostgreSQL at ${HOST}:${PORT}..."
max_retries=30
retry=0
until pg_isready -h "${HOST}" -p "${PORT}" -U "${POSTGRES_USER}" >/dev/null 2>&1; do
  retry=$((retry + 1))
  if [ "$retry" -ge "$max_retries" ]; then
    echo ">>> [db-migrate] ERROR: Database at ${HOST}:${PORT} not ready after $max_retries attempts." >&2
    exit 1
  fi
  sleep 2
done
echo ">>> [db-migrate] Database at ${HOST}:${PORT} is reachable."

migrate() {
  service="$1"; database="$2"; schema="$3"
  echo ">>> [prisma] ${service} -> ${database} (schema=${schema})"
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${HOST}:${PORT}/${database}?schema=${schema}${SSL_PARAM}" \
    pnpm --filter "${service}" db:migrate:deploy
}

migrate identity-service      logix_identity      identity
migrate master-data-service   logix_master_data    master_data
migrate order-service         logix_order         orders
migrate inventory-service     logix_inventory     inventory
migrate fulfillment-service   logix_fulfillment   fulfillment
migrate transport-service     logix_transport     transport
migrate notification-service  logix_notification  notification
migrate audit-service         logix_audit         audit

echo "All Prisma migrations applied successfully."
