import { z } from 'zod';

/**
 * Base configuration schema shared by all services.
 *
 * Every NestJS service must provide at least these environment variables.
 * Services extend this schema with service-specific fields.
 *
 * Secrets must come from environment/secret mechanisms and must never
 * be committed to source control or written to logs/events.
 * @see docs/architecture/runtime-architecture.md §5
 */
export const baseConfigSchema = z.object({
  /** Runtime environment. Affects logging format and error detail level. */
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  /** HTTP port the service listens on. */
  PORT: z.coerce.number().int().positive().default(3000),

  /** Canonical service name used in logs, metrics, and event envelopes. */
  SERVICE_NAME: z.string().min(1),
});

/**
 * Database configuration schema for services with PostgreSQL persistence.
 */
export const databaseConfigSchema = z.object({
  /** PostgreSQL connection URL. */
  DATABASE_URL: z.string().url().startsWith('postgres'),
});

/**
 * Kafka configuration schema for services producing/consuming domain events.
 */
export const kafkaConfigSchema = z.object({
  /** Comma-separated list of Kafka broker addresses. */
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((v) => v.split(',')),

  /** Kafka client ID, typically the service name. */
  KAFKA_CLIENT_ID: z.string().min(1),

  /** Consumer group ID for this service. */
  KAFKA_GROUP_ID: z.string().min(1).optional(),
});

/**
 * Redis configuration schema for services using cache/ephemeral state.
 */
export const redisConfigSchema = z.object({
  /** Redis connection URL. */
  REDIS_URL: z.string().url().startsWith('redis').optional(),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type KafkaConfig = z.infer<typeof kafkaConfigSchema>;
export type RedisConfig = z.infer<typeof redisConfigSchema>;
