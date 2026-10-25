import { databaseConfigSchema } from '@logix/config';
import { z } from 'zod';

export const transportConfigSchema = databaseConfigSchema.extend({
  INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
});
