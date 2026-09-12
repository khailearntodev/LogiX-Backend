# LogiX Backend

LogiX-Backend là nền tảng microservice cho hệ thống quản lý logistics B2B đa
tenant, bao gồm quản lý đơn hàng, tồn kho, fulfillment, vận chuyển, route
optimization, forecasting, và Agentic AI.

## Kiến trúc tổng quan

```text
Clients / UI
    |
    v
API Gateway (port 3000)
    |
    +------------------------------+
    |                              |
    v                              v
Core Business Services        Planner Agent
    |                              |
    |                              +--→ Business Tools / APIs
    |                              +--→ Forecast Tool
    |                              +--→ Route Optimizer
    |
    +------ synchronous APIs ------+
    |
    +------ domain events ------→ Kafka ------→ interested consumers

Persistence:
- Service-owned PostgreSQL (via Prisma)
- Redis for explicitly justified cache/state
```

## Monorepo Structure

```
LogiX-Backend/
├── apps/                          # Service applications
│   ├── api-gateway/              # External API entry point (port 3000)
│   ├── identity-service/         # Tenant, user, auth (port 3001)
│   ├── order-service/            # SalesOrder lifecycle (port 3002)
│   ├── master-data-service/      # Customer, product, warehouse (port 3003)
│   ├── inventory-service/        # Stock management (port 3004)
│   ├── fulfillment-service/      # Shipment lifecycle (port 3005)
│   ├── transport-service/        # Delivery trips, routing (port 3006)
│   ├── notification-service/     # Event-driven notifications (port 3007)
│   ├── audit-service/            # Immutable audit records (port 3008)
│   ├── agent-service/            # AI Planner Agent (Python/FastAPI)
│   ├── forecast-service/         # Demand forecasting (Python/FastAPI)
│   └── route-optimizer-service/  # Route optimization (Python/FastAPI)
│
├── libs/                          # Shared platform libraries
│   ├── common/                   # @logix/common — Types, constants, utilities
│   ├── config/                   # @logix/config — Config management (Zod)
│   ├── logger/                   # @logix/logger — Structured logging (Pino)
│   ├── errors/                   # @logix/errors — Domain errors & exception filter
│   ├── database/                 # @logix/database — Shared Prisma module
│   └── messaging/                # @logix/messaging — Kafka event messaging
│
├── infrastructure/                # Docker Compose, K8s manifests
│   ├── docker-compose/
│   └── postgres/
│
├── docs/                          # Architecture & design documentation
│   ├── architecture/
│   ├── decisions/
│   ├── patterns/
│   └── plans/
│
├── pnpm-workspace.yaml           # Workspace: apps/* + libs/*
├── turbo.json                     # Turborepo build pipeline
└── package.json                   # Root package with turbo scripts
```

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js (NestJS 12) / Python (FastAPI) |
| **Language** | TypeScript 6 / Python 3.11+ |
| **Database** | PostgreSQL 17 (Prisma ORM / SQLAlchemy) |
| **Messaging** | Apache Kafka (kafkajs) |
| **Cache** | Redis (when justified) |
| **Logging** | Pino (structured JSON) |
| **Config** | @nestjs/config + Zod validation |
| **Build** | Turborepo + pnpm workspaces |
| **Testing** | Vitest / Pytest |
| **Linting** | oxlint |
| **Container** | Docker Compose (dev) / Kubernetes (production) |

## Shared Libraries (`libs/`)

### @logix/common
Types, constants, và utilities dùng chung:
- `TenantContext` — Tenant identity cho mọi operation
- `CorrelationContext` — Distributed tracing metadata
- `RequestContext` — Combined context cho request lifecycle
- `ServiceId` — Canonical service identifiers
- `generateId()` — UUID generation

### @logix/config
Config management với Zod schema validation:
- Fail-fast khi thiếu env vars
- Typed config schemas: `baseConfigSchema`, `databaseConfigSchema`, `kafkaConfigSchema`
- Extensible — mỗi service merge thêm schema riêng

### @logix/logger
Structured logging dựa trên Pino:
- JSON output (production) / Pretty print (development)
- Auto-inject `correlationId`, `tenantId`, `serviceName`
- Redact sensitive fields (password, token, authorization)
- HTTP request/response logging

### @logix/errors
Domain error hierarchy và standardized error responses:
- `EntityNotFoundError`, `BusinessRuleViolationError`, `ConcurrencyConflictError`
- `TenantAccessDeniedError`, `ValidationError`, `InvalidStateTransitionError`
- `GlobalExceptionFilter` — Consistent JSON error envelope

### @logix/database
Shared Prisma module:
- `withPrismaLifecycle` / `PrismaBaseService` — Connection lifecycle, health check, logging
- `DatabaseModule.forRoot()` — Dynamic module factory

### @logix/messaging
Kafka domain event system:
- `DomainEventEnvelope` — Standardized event wrapper
- `KafkaProducerService` — Type-safe event publishing
- `MessagingModule` — Kafka client configuration
- Type-safe payload interfaces cho tất cả domain events

## Quick Start

```bash
# Install dependencies
pnpm install

# Start infrastructure (PostgreSQL, Kafka, Redis)
docker compose -f infrastructure/docker-compose/database.yml up -d

# Run all services in development
pnpm dev

# Run a specific service
cd apps/identity-service && pnpm start:dev

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## Environment Variables

Mỗi service cần file `.env`:

```env
# Base (required cho mọi service)
NODE_ENV=development
PORT=3001
SERVICE_NAME=identity-service

# Database (required cho services có Prisma)
DATABASE_URL=postgresql://user:pass@localhost:5433/identity_db

# Kafka (required cho services có messaging)
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=identity-service
KAFKA_GROUP_ID=identity-service-group
```

## Architecture Principles

1. **Core logistics is AI-independent** — Core workflows continue without AI
2. **Business ownership is explicit** — Each entity has one owning service
3. **Events are integration contracts** — Versioned schemas, idempotent consumers
4. **Tenant isolation is system-wide** — Every operation carries tenant context
5. **Authorization is server-side** — RBAC consistent across all paths
6. **Sensitive actions require confirmation** — Preview + explicit confirm
7. **Quantitative engines are deterministic** — Forecast/routing by dedicated components
8. **Validation is part of architecture** — Executable proof required

## Documentation

- [Architecture Overview](docs/architecture/README.md)
- [Service Boundaries](docs/architecture/service-boundaries.md)
- [Event Architecture](docs/architecture/event-architecture.md)
- [Runtime Architecture](docs/architecture/runtime-architecture.md)
- [Data Ownership](docs/architecture/data-ownership.md)
- [Database Design](docs/architecture/database-design.md)
