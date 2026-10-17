import {
  SHIPMENT_EVENT as E,
  SHIPMENT_STATUS as S,
  type ShipmentStatus,
} from '@logix/messaging';
import { DomainError, ErrorCode } from '@logix/errors';

export const INTENT_STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
} as const;
export const SHIPMENT_AGGREGATE = 'Shipment';
export const SHIPMENT_CONSUMER = 'fulfillment-order-events';
export const ORDER_HTTP_TIMEOUT_MS = 5_000;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_NUMBER = Math.floor(2_147_483_647 / MAX_PAGE_SIZE);
export const MAX_REASON_LENGTH = 1_000;

export class ShipmentError extends DomainError {
  readonly code = ErrorCode.BUSINESS_RULE_VIOLATION;
  constructor(
    readonly reason: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message, { reason });
  }
}
export const ShipmentErrors = {
  missing: () =>
    new ShipmentError('SHIPMENT_NOT_FOUND', 404, 'Không tìm thấy lô giao'),
  version: () =>
    new ShipmentError(
      'SHIPMENT_VERSION_CONFLICT',
      409,
      'Lô giao đã thay đổi, vui lòng tải lại',
    ),
  transition: () =>
    new ShipmentError(
      'SHIPMENT_INVALID_TRANSITION',
      409,
      'Trạng thái không cho phép thao tác này',
    ),
  pending: () =>
    new ShipmentError(
      'SHIPMENT_DISPATCH_PENDING',
      409,
      'Đang xử lý xuất giao, vui lòng tải lại',
    ),
  unavailable: () =>
    new ShipmentError(
      'ORDER_UNAVAILABLE',
      503,
      'Dịch vụ đơn hàng chưa phản hồi; ý định xuất giao đã lưu sẽ được thử lại',
    ),
  upstream: (status: number) =>
    new ShipmentError(
      'ORDER_REJECTED',
      status === 409 ? 409 : 502,
      'Dịch vụ đơn hàng từ chối yêu cầu',
    ),
};
export const TRANSITIONS: Partial<
  Record<ShipmentStatus, { from: ShipmentStatus; event: string }>
> = {
  [S.PICKING]: { from: S.PENDING_PICK, event: E.PICKING },
  [S.READY_TO_SHIP]: { from: S.PICKING, event: E.READY },
  [S.DISPATCHED]: { from: S.READY_TO_SHIP, event: E.DISPATCHED },
  [S.DELIVERED]: { from: S.DISPATCHED, event: E.DELIVERED },
  [S.FAILED]: { from: S.DISPATCHED, event: E.FAILED },
};
export function assertShipmentVersion(actual: bigint, expected: number): void {
  if (actual !== BigInt(expected)) throw ShipmentErrors.version();
}
export function assertShipmentTransition(
  from: string,
  to: ShipmentStatus,
): string {
  const transition = TRANSITIONS[to];
  if (!transition || transition.from !== from)
    throw ShipmentErrors.transition();
  return transition.event;
}
