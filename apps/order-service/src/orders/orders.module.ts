import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrdersHealthController } from './orders-health.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [OrdersHealthController],
})
export class OrdersModule {}
