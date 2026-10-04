import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { LogixConfigModule } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthProxyMiddleware } from './proxy/auth-proxy.middleware.js';
import { InventoryProxyMiddleware } from './proxy/inventory-proxy.middleware.js';
import { MasterDataProxyMiddleware } from './proxy/master-data-proxy.middleware.js';

@Module({
  imports: [
    LogixConfigModule.forRoot(),

    LogixLoggerModule.forRoot({
      serviceName: 'api-gateway',
    }),

    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 60000,
        limit: 30,
      },
    ]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Chuyển hướng các request /api/v1/auth và /api/v1/iam sang identity-service
    consumer
      .apply(AuthProxyMiddleware)
      .forRoutes(
        { path: 'api/v1/auth', method: RequestMethod.ALL },
        { path: 'api/v1/auth/*', method: RequestMethod.ALL },
        { path: 'api/v1/iam', method: RequestMethod.ALL },
        { path: 'api/v1/iam/*', method: RequestMethod.ALL },
      );

    // Chuyển hướng các request /api/v1/inventory sang inventory-service
    consumer
      .apply(InventoryProxyMiddleware)
      .forRoutes(
        { path: 'api/v1/inventory', method: RequestMethod.ALL },
        { path: 'api/v1/inventory/*', method: RequestMethod.ALL },
      );
    consumer
      .apply(MasterDataProxyMiddleware)
      .forRoutes(
        { path: 'api/v1/customers', method: RequestMethod.ALL },
        { path: 'api/v1/customers/*', method: RequestMethod.ALL },
        { path: 'api/v1/products', method: RequestMethod.ALL },
        { path: 'api/v1/products/*', method: RequestMethod.ALL },
        { path: 'api/v1/warehouses', method: RequestMethod.ALL },
        { path: 'api/v1/warehouses/*', method: RequestMethod.ALL },
        { path: 'api/v1/vehicles', method: RequestMethod.ALL },
        { path: 'api/v1/vehicles/*', method: RequestMethod.ALL },
      );
  }
}
