export const FULFILLMENT_PERMISSIONS = {
  SHIPMENT_READ: 'fulfillment:shipment:read',
  SHIPMENT_UPDATE: 'fulfillment:shipment:update',
  SHIPMENT_DISPATCH: 'fulfillment:shipment:dispatch',
  SHIPMENT_COMPLETE: 'fulfillment:shipment:complete',
} as const;

export const INVENTORY_PERMISSIONS = {
  WAREHOUSE_READ: 'inventory:warehouse:read',
  WAREHOUSE_CREATE: 'inventory:warehouse:create',
  WAREHOUSE_UPDATE: 'inventory:warehouse:update',
  WAREHOUSE_DELETE: 'inventory:warehouse:delete',
  STOCK_READ: 'inventory:stock:read',
  STOCK_ADJUST: 'inventory:stock:adjust',
} as const;

export const TRANSPORT_PERMISSIONS = {
  TRIP_READ: 'transport:trip:read',
  TRIP_CREATE: 'transport:trip:create',
  TRIP_UPDATE: 'transport:trip:update',
  TRIP_DISPATCH: 'transport:trip:dispatch',
  ROUTE_READ: 'transport:route:read',
  ROUTE_OPTIMIZE: 'transport:route:optimize',
  ROUTE_APPROVE: 'transport:route:approve',
  DRIVER_READ: 'transport:driver:read',
  DRIVER_UPDATE: 'transport:driver:update',
  VEHICLE_READ: 'transport:vehicle:read',
  VEHICLE_MANAGE: 'transport:vehicle:manage',
} as const;

export const MASTER_DATA_DRIVER_PERMISSIONS = {
  READ: 'master-data:driver:read',
  MANAGE: 'master-data:driver:manage',
} as const;

export const MASTER_DATA_PERMISSIONS = {
  DRIVER_READ: MASTER_DATA_DRIVER_PERMISSIONS.READ,
  DRIVER_MANAGE: MASTER_DATA_DRIVER_PERMISSIONS.MANAGE,
  CUSTOMER_READ: 'master-data:customer:read',
  CUSTOMER_MANAGE: 'master-data:customer:manage',
  PRODUCT_READ: 'master-data:product:read',
  PRODUCT_MANAGE: 'master-data:product:manage',
} as const;

export const ORDER_PERMISSIONS = {
  SALES_ORDER_READ: 'order:sales-order:read',
  SALES_ORDER_CREATE: 'order:sales-order:create',
  SALES_ORDER_UPDATE: 'order:sales-order:update',
  SALES_ORDER_APPROVE: 'order:sales-order:approve',
  SALES_ORDER_CANCEL: 'order:sales-order:cancel',
} as const;

export const IAM_PERMISSIONS = {
  ROLE_READ: 'iam:role:read',
  ROLE_MANAGE: 'iam:role:manage',
  MEMBER_READ: 'iam:member:read',
  MEMBER_INVITE: 'iam:member:invite',
  MEMBER_ASSIGN_ROLE: 'iam:member:assign-role',
  MEMBER_REMOVE: 'iam:member:remove',
  ORGANIZATION_MANAGE: 'iam:organization:manage',
  AI_INSTRUCTIONS_MANAGE: 'iam:ai-instructions:manage',
} as const;

export const FORECAST_PERMISSIONS = {
  READ: 'forecast:read',
  RUN: 'forecast:run',
} as const;

export const REPORT_PERMISSIONS = {
  ANALYTICS_READ: 'report:analytics:read',
  EXPORT_EXECUTE: 'report:export:execute',
} as const;

export const AGENT_MODEL_CONFIG_PERMISSIONS = {
  READ: 'agent:model-config:read',
  MANAGE: 'agent:model-config:manage',
} as const;

export const MEMBER_RESTRICTED_PERMISSIONS = [
  MASTER_DATA_DRIVER_PERMISSIONS.READ,
  TRANSPORT_PERMISSIONS.DRIVER_READ,
] as const;
