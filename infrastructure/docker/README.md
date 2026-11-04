# LogiX Backend Docker Infrastructure

Production-ready, multi-stage Docker environment for the LogiX microservices backend (12 services + event-driven Kafka KRaft + PostgreSQL).

---

## 1. Quick Start

### Mode A: Fully Local Stack (Default)
Runs all 12 microservices, Kafka KRaft, and a local PostgreSQL 17 container:

```bash
cd infrastructure/docker
cp .env.example .env

# Build and start all services
docker compose up -d --build

# Verify container status
docker compose ps
```

### Mode B: Hybrid Mode (Local Services + Cloud Database)
Saves ~1 GB RAM and disk space on your local machine by pointing services to **Azure Database for PostgreSQL** (or Neon / Supabase):

1. In `.env`, remove `local-db` from `COMPOSE_PROFILES`:
   ```env
   COMPOSE_PROFILES=ai
   ```
2. Configure cloud database credentials:
   ```env
   POSTGRES_HOST=your-db.postgres.database.azure.com
   POSTGRES_PORT=5432
   POSTGRES_USER=logixadmin
   POSTGRES_PASSWORD=YourStrongPassword
   POSTGRES_SSL_PARAM=&sslmode=require
   POSTGRES_PY_SSL_PARAM=?ssl=require
   ```
3. Run the stack (the local `postgres` container will NOT be started):
   ```bash
   docker compose up -d --build
   ```

---

## 2. Seed Demo Data

After services are healthy, run the one-shot seeding container (populates demo users, warehouses, inventory, orders, trips, and 90-day demand forecast records):

```bash
docker compose --profile seed run --rm seed
```

---

## 3. Architecture & Service Map

| Service | Runtime | Type | Internal Port | Published Port |
| :--- | :--- | :--- | :--- | :--- |
| **api-gateway** | Node 22 (NestJS) | Gateway / Reverse Proxy | 3000 | `3000` |
| **identity-service** | Node 22 (NestJS) | Auth / IAM | 3001 | Internal |
| **master-data-service** | Node 22 (NestJS) | Products, Warehouses | 3003 | Internal |
| **order-service** | Node 22 (NestJS) | Orders & Outbox events | 3002 | Internal |
| **inventory-service** | Node 22 (NestJS) | Stock / Reservations | 3004 | Internal |
| **fulfillment-service**| Node 22 (NestJS) | Waves & Picking | 3005 | Internal |
| **transport-service**  | Node 22 (NestJS) | Trips & Dispatch | 3006 | Internal |
| **notification-service**| Node 22 (NestJS)| Alerts & Events | 3007 | Internal |
| **audit-service**      | Node 22 (NestJS) | Immutable Audit logs | 3008 | Internal |
| **agent-service**      | Python 3.12 (uv) | GenAI / LangGraph Agent | 8001 | `8001` |
| **forecast-service**   | Python 3.12 (uv) | Demand ML (Prophet) | 8002 | `8002` |
| **route-optimizer**    | Python 3.12 (uv) | VRP Solver (Google OR-Tools) | 8003 | Internal |
| **kafka**              | Java (KRaft)    | Event Streaming Broker | 29092, 9092 | `9094` |
| **postgres**           | PostgreSQL 17   | Service Databases | 5432 | `5434` (Host) |

---

## 4. Dockerfile Design

- **`node/Dockerfile`**: Single generic multi-stage image for all 9 NestJS services. Uses `pnpm` workspace filters, compiles Prisma clients directly into `dist/`, and strips all build tools and devDependencies from the final minimal runtime image.
- **`python/Dockerfile`**: Built with `astral-sh/uv` multi-stage build. Creates an isolated `/opt/venv` virtualenv, installs C/C++ dependencies (`prophet`, `ortools`), applies Alembic migrations with an automatic retry loop, and runs as an unprivileged user (`app`, UID 10001).
- **`tools/Dockerfile`**: Dedicated one-shot image containing the full workspace and Prisma CLI to execute `db:migrate:deploy` across all 8 Node databases and run the demonstration seeding script.

---

## 5. Useful Commands

```bash
# View live logs of a specific service
docker compose logs -f api-gateway

# Check health and status of all containers
docker compose ps

# Stop all containers (keeps persistent volumes intact)
docker compose stop

# Stop and remove containers and local network
docker compose down

# Clean up Docker build cache to free disk space
docker builder prune -f
```
