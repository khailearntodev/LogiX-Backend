import { z } from 'zod';

/**
 * Required downstream targets make the gateway fail fast instead of routing
 * to an implicit default host.
 */
export const gatewayConfigSchema = z.object({
  MASTER_DATA_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
  ORDER_SERVICE_URL: z.string().url(),
  FULFILLMENT_SERVICE_URL: z.string().url(),
  TRANSPORT_SERVICE_URL: z.string().url(),
});
