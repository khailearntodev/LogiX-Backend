import { databaseConfigSchema } from '@logix/config';
import { z } from 'zod';

export const transportConfigSchema = databaseConfigSchema.extend({
  INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  TRIP_CANCEL_PREVIEW_SECRET: z.string().min(32),
  MASTER_DATA_SERVICE_URL: z.string().url(),
  FULFILLMENT_SERVICE_URL: z.string().url(),
  ROUTE_OPTIMIZER_SERVICE_URL: z.string().url(),
  ROUTE_OPTIMIZER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000),
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_CLIENT_ID: z.string().min(1),
  KAFKA_GROUP_ID: z.string().min(1),
  KAFKA_FULFILLMENT_TOPIC: z.string().min(1),
  KAFKA_TRANSPORT_TOPIC: z.string().min(1),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive(),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive(),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive(),
  OUTBOX_RETRY_MAX_MS: z.coerce.number().int().positive(),
  OUTBOX_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive(),
  RECOVERY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(5000),
});
