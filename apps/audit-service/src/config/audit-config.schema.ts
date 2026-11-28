import { databaseConfigSchema, kafkaConfigSchema } from '@logix/config';
import { z } from 'zod';

export const auditConfigSchema = databaseConfigSchema
  .merge(kafkaConfigSchema)
  .extend({
    JWT_SECRET: z.string().min(16),
    KAFKA_IDENTITY_TOPIC: z.string().min(1),
    KAFKA_INVENTORY_TOPIC: z.string().min(1),
    KAFKA_ORDER_TOPIC: z.string().min(1),
    KAFKA_FULFILLMENT_TOPIC: z.string().min(1),
    KAFKA_TRANSPORT_TOPIC: z.string().min(1),
    KAFKA_AGENT_TOPIC: z.string().min(1),
  });

export type AuditConfig = z.infer<typeof auditConfigSchema>;
