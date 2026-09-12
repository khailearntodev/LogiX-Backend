export { LogixConfigModule } from './config.module.js';
export type { LogixConfigModuleOptions } from './config.module.js';
export {
  baseConfigSchema,
  databaseConfigSchema,
  kafkaConfigSchema,
  redisConfigSchema,
  type BaseConfig,
  type DatabaseConfig,
  type KafkaConfig,
  type RedisConfig,
} from './config.schema.js';

// Re-export NestJS ConfigService for convenience
export { ConfigService } from '@nestjs/config';
