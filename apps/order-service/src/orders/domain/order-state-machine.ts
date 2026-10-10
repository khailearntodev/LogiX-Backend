import { InvalidStateTransitionError } from '@logix/errors';
import { ORDER_STATUS, type OrderStatus } from './order-status.js';

const SALES_ORDER_ENTITY = 'SalesOrder';

const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [ORDER_STATUS.DRAFT]: [ORDER_STATUS.PENDING_STOCK, ORDER_STATUS.CONFIRMED, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.PENDING_STOCK]: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.CONFIRMED]: [ORDER_STATUS.PICKING, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.PICKING]: [ORDER_STATUS.READY_TO_SHIP, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.READY_TO_SHIP]: [ORDER_STATUS.IN_DELIVERY, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.IN_DELIVERY]: [ORDER_STATUS.COMPLETED, ORDER_STATUS.DELIVERY_FAILED],
  [ORDER_STATUS.DELIVERY_FAILED]: [ORDER_STATUS.IN_DELIVERY],
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.CANCELED]: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(SALES_ORDER_ENTITY, from, to);
  }
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
