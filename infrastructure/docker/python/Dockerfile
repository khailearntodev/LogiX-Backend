# syntax=docker/dockerfile:1.7
#
# Generic image for the FastAPI services powered by uv.
# Build context MUST be the repository root (LogiX-Backend/).

ARG PYTHON_VERSION=3.12-slim

# ------------------------------------------------------------- builder
FROM python:${PYTHON_VERSION} AS builder

# Copy uv & uvx binaries from official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Environment flags for uv
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_HTTP_TIMEOUT=180 \
    UV_RETRIES=10 \
    UV_CONCURRENT_DOWNLOADS=4

WORKDIR /build

# Create virtual environment with uv
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

ARG SERVICE
ARG EXTRAS=""

# Copy service source code and pyproject.toml
COPY apps/${SERVICE}/ ./

# Install package and dependencies with uv pip into /opt/venv (using BuildKit cache mount)
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "${EXTRAS}" ]; then \
      uv pip install ".[${EXTRAS}]"; \
    else \
      uv pip install .; \
    fi

# ------------------------------------------------------------- runtime
FROM python:${PYTHON_VERSION} AS runtime

RUN useradd --create-home --uid 10001 app

# Copy uv binary into runtime for CLI operations / debugging
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

ARG SERVICE
ARG PACKAGE
ARG PORT=8000
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/app \
    PORT=${PORT} \
    APP_MODULE=${PACKAGE}.main:app

# Copy built virtual environment
COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY apps/${SERVICE}/alembic.ini ./alembic.ini
COPY apps/${SERVICE}/migrations ./migrations
COPY apps/${SERVICE}/src ./src
COPY infrastructure/docker/scripts/entrypoint-python.sh /usr/local/bin/entrypoint

# Normalise CRLF and grant execution permissions
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint && chmod +x /usr/local/bin/entrypoint \
 && chown -R app:app /app

USER app
EXPOSE ${PORT}

# Zero-dependency healthcheck using Python standard library
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=6 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health/live')" || exit 1

ENTRYPOINT ["entrypoint"]
