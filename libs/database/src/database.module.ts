import { DynamicModule, Global, Module, Type } from '@nestjs/common';
import { PrismaBaseService } from './prisma-base.service.js';

export interface DatabaseModuleOptions {
  /**
   * The service-specific PrismaService class that extends PrismaBaseService.
   * Each service provides its own PrismaService generated from its own schema.
   */
  prismaServiceClass: Type<PrismaBaseService>;
}

/**
 * DatabaseModule — Dynamic module factory for service-owned database access.
 *
 * Each NestJS service uses DatabaseModule.forRoot() with its own PrismaService
 * class. The module is registered as @Global so the PrismaService is available
 * throughout the service without explicit imports.
 *
 * @example
 * // In identity-service/src/database/database.module.ts:
 * import { DatabaseModule as BaseDatabaseModule } from '@logix/database';
 * import { PrismaService } from './prisma.service.js';
 *
 * @Module({})
 * export class DatabaseModule {
 *   static forRoot() {
 *     return BaseDatabaseModule.forRoot({ prismaServiceClass: PrismaService });
 *   }
 * }
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: PrismaBaseService,
          useClass: options.prismaServiceClass,
        },
        {
          provide: options.prismaServiceClass,
          useExisting: PrismaBaseService,
        },
      ],
      exports: [PrismaBaseService, options.prismaServiceClass],
    };
  }
}
