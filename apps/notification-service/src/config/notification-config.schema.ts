import { z } from 'zod';
import { databaseConfigSchema, kafkaConfigSchema } from '@logix/config';

const SECRET_MIN_LENGTH = 32;

/**
 * Runtime configuration owned by notification-service.
 *
 * The first implementation consumes the order and transport event streams and
 * authenticates both REST and WebSocket clients with the shared access-token
 * signing key.
 */
export const notificationConfigSchema = databaseConfigSchema
  .merge(kafkaConfigSchema)
  .extend({
    JWT_SECRET: z.string().min(SECRET_MIN_LENGTH),
    INTERNAL_SERVICE_JWT_SECRET: z.string().min(SECRET_MIN_LENGTH),
    IDENTITY_SERVICE_URL: z.string().url(),
    IDENTITY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive(),
    KAFKA_GROUP_ID: z.string().min(1),
    KAFKA_ORDER_TOPIC: z.string().min(1),
    KAFKA_TRANSPORT_TOPIC: z.string().min(1),
    WS_CORS_ORIGINS: z.string().min(1).optional(),
    DELIVERY_WORKER_ENABLED: z
      .preprocess(
        (value) => (value === 'false' ? false : value === 'true' ? true : value),
        z.boolean(),
      )
      .default(true),
    DELIVERY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    DELIVERY_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
    DELIVERY_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
    DELIVERY_LEASE_MS: z.coerce.number().int().positive().default(30_000),
    DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().positive().max(50).default(5),
    DELIVERY_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
    DELIVERY_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
    DELIVERY_RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    DELIVERY_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    KAFKA_NOTIFICATION_BROADCAST_TOPIC: z
      .string()
      .min(1)
      .default('notification.broadcast.requested.v1'),
    OUTBOX_RELAY_ENABLED: z
      .preprocess(
        (value) => (value === 'false' ? false : value === 'true' ? true : value),
        z.boolean(),
      )
      .default(true),
    OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
    OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(15_000),
    OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
    OUTBOX_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
    OUTBOX_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    MAX_BROADCAST_RECIPIENTS: z.coerce
      .number()
      .int()
      .positive()
      .max(50_000)
      .default(5_000),
    BROADCAST_FANOUT_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .max(500)
      .default(500),
  });

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;
