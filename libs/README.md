# Shared Platform Libraries

Thư mục `libs/` chứa các shared library packages được sử dụng bởi tất cả
NestJS services trong LogiX-Backend monorepo.

## Nguyên tắc

1. **Không chứa business logic** — Chỉ chứa cross-cutting infrastructure concerns
   (logging, config, error handling, messaging, database lifecycle).
2. **Contracts, không behavior** — Event payload interfaces là contracts;
   business logic xử lý event thuộc về service sở hữu.
3. **Mở rộng, không override** — Mỗi service có thể extend config schema,
   thêm error types, custom Prisma service mà không sửa lib.

## Package Map

| Package | Scope | Dependencies |
|---|---|---|
| `@logix/common` | Types, constants, utilities | — |
| `@logix/config` | Config management + Zod validation | `@nestjs/config`, `zod` |
| `@logix/logger` | Structured Pino logging | `nestjs-pino`, `pino` |
| `@logix/errors` | Domain errors + exception filter | `@nestjs/common` |
| `@logix/database` | Prisma lifecycle + health check | `@prisma/client`, `@prisma/adapter-pg` |
| `@logix/messaging` | Kafka producer + event envelope | `kafkajs`, `@logix/common` |

## Dependency Graph

```text
@logix/common ──────────────────────────────────────┐
     │                                               │
     ├── @logix/config                               │
     │        │                                      │
     │        ├── @logix/logger                      │
     │        │                                      │
     │        ├── @logix/database                    │
     │        │                                      │
     │        └── @logix/messaging ──────────────────┘
     │
     └── @logix/errors
```

## Sử dụng trong service

### Minimal service (không database, không Kafka)

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';

@Module({
  imports: [
    LogixConfigModule.forRoot(),
    LogixLoggerModule.forRoot({ serviceName: 'my-service' }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
```

### Service với database

```typescript
// app.module.ts
import { LogixConfigModule, databaseConfigSchema } from '@logix/config';

@Module({
  imports: [
    LogixConfigModule.forRoot({
      schema: databaseConfigSchema,  // validates DATABASE_URL
    }),
    LogixLoggerModule.forRoot({ serviceName: 'order-service' }),
    DatabaseModule,
  ],
})
export class AppModule {}
```

```typescript
// database/prisma.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { withPrismaLifecycle } from '@logix/database';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends withPrismaLifecycle(PrismaClient) {
  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    if (!connectionString) throw new Error('DATABASE_URL is required');
    super({ adapter: new PrismaPg({ connectionString }) });
  }
}
```

### Service với Kafka

```typescript
// app.module.ts
import { LogixConfigModule, databaseConfigSchema, kafkaConfigSchema } from '@logix/config';
import { MessagingModule } from '@logix/messaging';

@Module({
  imports: [
    LogixConfigModule.forRoot({
      schema: databaseConfigSchema.merge(kafkaConfigSchema),
    }),
    LogixLoggerModule.forRoot({ serviceName: 'order-service' }),
    DatabaseModule,
    MessagingModule.forRoot(),
  ],
})
export class AppModule {}
```

### Publishing domain events

```typescript
import { Injectable } from '@nestjs/common';
import { ServiceId } from '@logix/common';
import { KafkaProducerService } from '@logix/messaging';

@Injectable()
export class OrderService {
  constructor(private readonly producer: KafkaProducerService) {}

  async confirmOrder(orderId: string, ctx: RequestContext) {
    // ... business logic ...

    await this.producer.publish<'OrderConfirmed'>('order-events', {
      eventType: 'OrderConfirmed',
      eventVersion: 1,
      producer: ServiceId.ORDER_SERVICE,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      aggregateType: 'SalesOrder',
      aggregateId: orderId,
      aggregateVersion: order.version,
      payload: {
        orderId,
        confirmedAt: new Date().toISOString(),
      },
    });
  }
}
```

### Throwing domain errors

```typescript
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
  ConcurrencyConflictError,
  TenantAccessDeniedError,
} from '@logix/errors';

// Entity not found
throw new EntityNotFoundError('SalesOrder', orderId);

// Business rule violation
throw new BusinessRuleViolationError('Insufficient stock for product', {
  productId,
  requested: 10,
  available: 3,
});

// Optimistic versioning conflict
throw new ConcurrencyConflictError('SalesOrder', orderId, 3, 5);

// Cross-tenant access attempt
throw new TenantAccessDeniedError();
```

## Tạo service mới

1. Tạo NestJS app mới trong `apps/`
2. Thêm `@logix/*` workspace dependencies vào `package.json`
3. Sử dụng template `main.ts` và `app.module.ts` từ service hiện có
4. Nếu cần database: extend `PrismaBaseService`, tạo Prisma schema riêng
5. Nếu cần messaging: import `MessagingModule.forRoot()` và thêm `kafkaConfigSchema`
