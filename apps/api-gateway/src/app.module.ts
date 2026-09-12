import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthProxyMiddleware } from './proxy/auth-proxy.middleware.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Rate Limiting: Tối đa 60 requests / 1 phút cho toàn Gateway,
    // riêng endpoint nhạy cảm như Auth bảo vệ chống Brute Force
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 60000, // 1 phút
        limit: 30,  // Tối đa 30 requests / phút
      },
    ]),
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'api-gateway',
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Chuyển hướng các request /api/v1/auth sang identity-service
    consumer.apply(AuthProxyMiddleware).forRoutes('/api/v1/auth*');
  }
}
