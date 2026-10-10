import { z } from 'zod';
import { databaseConfigSchema } from '@logix/config';

const SECRET_MIN_LENGTH = 32;

/**
 * Order-service configuration. Every key is required: the service must fail
 * fast at startup instead of silently falling back to an unsafe default.
 */
export const orderConfigSchema = databaseConfigSchema.extend({
  JWT_SECRET: z.string().min(SECRET_MIN_LENGTH),
  INTERNAL_SERVICE_JWT_SECRET: z.string().min(SECRET_MIN_LENGTH),
  MASTER_DATA_SERVICE_URL: z.string().url(),
  INVENTORY_SERVICE_URL: z.string().url(),
  ORDER_MAX_LINES: z.coerce.number().int().positive(),
});

export type OrderConfig = z.infer<typeof orderConfigSchema>;
