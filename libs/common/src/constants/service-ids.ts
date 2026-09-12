/**
 * Canonical service identifiers for the LogiX platform.
 *
 * Used as the `producer` field in domain event envelopes and for
 * consistent service identification in logs, metrics, and tracing.
 *
 * @see docs/architecture/service-boundaries.md §2
 */
export const ServiceId = {
  API_GATEWAY: 'api-gateway',
  IDENTITY_SERVICE: 'identity-service',
  MASTER_DATA_SERVICE: 'master-data-service',
  ORDER_SERVICE: 'order-service',
  INVENTORY_SERVICE: 'inventory-service',
  FULFILLMENT_SERVICE: 'fulfillment-service',
  TRANSPORT_SERVICE: 'transport-service',
  NOTIFICATION_SERVICE: 'notification-service',
  AUDIT_SERVICE: 'audit-service',
  AGENT_SERVICE: 'agent-service',
  FORECAST_SERVICE: 'forecast-service',
  ROUTE_OPTIMIZER_SERVICE: 'route-optimizer-service',
} as const;

export type ServiceId = (typeof ServiceId)[keyof typeof ServiceId];
