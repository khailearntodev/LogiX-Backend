import { z } from 'zod';

/**
 * Required downstream targets make the gateway fail fast instead of routing
 * to an implicit default host.
 */
export const gatewayConfigSchema = z.object({
  IDENTITY_SERVICE_URL: z.string().url(),
  ORDER_SERVICE_URL: z.string().url(),
  FULFILLMENT_SERVICE_URL: z.string().url(),
});
