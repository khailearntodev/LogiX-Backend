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
    KAFKA_ORDER_TOPIC: z.string().min(1),
    KAFKA_TRANSPORT_TOPIC: z.string().min(1),
    WS_CORS_ORIGINS: z.string().min(1).optional(),
  });

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;
