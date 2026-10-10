export const ORDER_PERMISSIONS = {
  READ: 'order:sales-order:read',
  CREATE: 'order:sales-order:create',
  UPDATE: 'order:sales-order:update',
  APPROVE: 'order:sales-order:approve',
  CANCEL: 'order:sales-order:cancel',
} as const;

export type OrderPermission = (typeof ORDER_PERMISSIONS)[keyof typeof ORDER_PERMISSIONS];
