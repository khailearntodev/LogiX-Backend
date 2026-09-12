import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { z, ZodObject, ZodRawShape } from 'zod';
import { baseConfigSchema } from './config.schema.js';

export interface LogixConfigModuleOptions {
  /**
   * Additional Zod schema to merge with the base schema.
   * Use this to add service-specific configuration requirements.
   *
   * @example
   * LogixConfigModule.forRoot({
   *   schema: databaseConfigSchema.merge(kafkaConfigSchema),
   * })
   */
  schema?: ZodObject<ZodRawShape>;

  /**
   * Path(s) to .env files. Defaults to `.env`.
   */
  envFilePath?: string | string[];
}

/**
 * LogixConfigModule — Central configuration module for all LogiX services.
 *
 * Wraps @nestjs/config with Zod validation so the application fails fast
 * at startup if required environment variables are missing or invalid.
 *
 * @example
 * // In a service's AppModule:
 * @Module({
 *   imports: [
 *     LogixConfigModule.forRoot({
 *       schema: databaseConfigSchema,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 */
@Module({})
export class LogixConfigModule {
  private static readonly logger = new Logger(LogixConfigModule.name);

  static forRoot(options: LogixConfigModuleOptions = {}): DynamicModule {
    const mergedSchema = options.schema
      ? baseConfigSchema.merge(options.schema)
      : baseConfigSchema;

    return {
      module: LogixConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: options.envFilePath ?? '.env',
          validate: (config: Record<string, unknown>) => {
            const result = mergedSchema.safeParse(config);
            if (!result.success) {
              const errors = result.error.issues
                .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
                .join('\n');
              const message = `Configuration validation failed:\n${errors}`;
              this.logger.error(message);
              throw new Error(message);
            }
            return result.data as Record<string, unknown>;
          },
        }),
      ],
      exports: [ConfigModule],
    };
  }
}
