import { z } from 'zod';
import {
  databaseConfigSchema,
  kafkaConfigSchema,
  outboxConfigSchema,
} from '@logix/config';

export const fulfillmentConfigSchema = databaseConfigSchema
  .merge(kafkaConfigSchema)
  .merge(outboxConfigSchema)
  .extend({
    JWT_SECRET: z.string().min(32),
    INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
    ORDER_SERVICE_URL: z.string().url(),
    KAFKA_FULFILLMENT_TOPIC: z.string().min(1),
    KAFKA_GROUP_ID: z.string().min(1),
  });
