import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_AUTH_OPTIONS,
  InternalServiceGuard,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { DriverUsersController } from './driver-users.controller.js';
import { DriverUsersService } from './driver-users.service.js';

@Module({
  controllers: [DriverUsersController],
  providers: [
    DriverUsersService,
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: ServiceId.IDENTITY_SERVICE,
      }),
    },
  ],
})
export class DriverUsersModule {}
