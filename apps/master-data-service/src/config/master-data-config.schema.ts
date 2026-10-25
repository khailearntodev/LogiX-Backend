import { z } from 'zod';
import { databaseConfigSchema } from '@logix/config';

export const masterDataConfigSchema = databaseConfigSchema.extend({
  JWT_SECRET: z.string().min(32),
  INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
  IDENTITY_SERVICE_URL: z.string().url(),
  TRANSPORT_SERVICE_URL: z.string().url(),
});
