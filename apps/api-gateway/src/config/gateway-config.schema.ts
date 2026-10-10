import { z } from 'zod';

/**
 * Gateway configuration for downstream services added after the initial
 * proxies. Required keys make the gateway fail fast instead of routing to an
 * implicit default host.
 */
export const gatewayConfigSchema = z.object({
  ORDER_SERVICE_URL: z.string().url(),
});
