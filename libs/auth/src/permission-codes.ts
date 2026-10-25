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
} as const;

export const MASTER_DATA_DRIVER_PERMISSIONS = {
  READ: 'master-data:driver:read',
  MANAGE: 'master-data:driver:manage',
} as const;

export const MEMBER_RESTRICTED_PERMISSIONS = [
  MASTER_DATA_DRIVER_PERMISSIONS.READ,
  TRANSPORT_PERMISSIONS.DRIVER_READ,
] as const;
