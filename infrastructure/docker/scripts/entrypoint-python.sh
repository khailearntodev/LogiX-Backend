#!/bin/sh
# Container entrypoint for the FastAPI services.
#   1. apply Alembic migrations with retry (skippable with RUN_MIGRATIONS=false)
#   2. exec uvicorn so it receives SIGTERM directly
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying alembic migrations..."
  max_retries=5
  retry_count=0
  until alembic -c alembic.ini upgrade head; do
    retry_count=$((retry_count + 1))
    if [ "$retry_count" -ge "$max_retries" ]; then
      echo "[entrypoint] ERROR: alembic migrations failed after $max_retries attempts." >&2
      exit 1
    fi
    echo "[entrypoint] database not ready or locked, retrying in 2s ($retry_count/$max_retries)..."
    sleep 2
  done
  echo "[entrypoint] alembic migrations applied successfully."
fi

echo "[entrypoint] starting ${APP_MODULE} on :${PORT}"
# shellcheck disable=SC2086
exec uvicorn "${APP_MODULE}" --host 0.0.0.0 --port "${PORT}" ${UVICORN_ARGS:-}
