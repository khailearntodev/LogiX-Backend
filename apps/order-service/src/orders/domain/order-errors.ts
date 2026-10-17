import { HttpStatus } from '@nestjs/common';
import { DomainError, ErrorCode } from '@logix/errors';

/**
 * Order-specific business reasons. They travel in `details.reason` so clients
 * can branch on them while `error` keeps the platform-wide ErrorCode vocabulary.
 */
export const ORDER_ERROR_REASON = {
  NOT_FOUND: 'ORDER_NOT_FOUND',
  INVALID_TRANSITION: 'ORDER_INVALID_TRANSITION',
  VERSION_CONFLICT: 'ORDER_VERSION_CONFLICT',
  NO_CHANGES: 'ORDER_NO_CHANGES',
  INVALID_DATE_RANGE: 'ORDER_INVALID_DATE_RANGE',
  ADDRESS_NOT_OF_CUSTOMER: 'ORDER_ADDRESS_NOT_OF_CUSTOMER',
  ADDRESS_NOT_SHIPPING: 'ORDER_ADDRESS_NOT_SHIPPING',
  MASTER_DATA_NOT_FOUND: 'ORDER_MASTER_DATA_NOT_FOUND',
  MASTER_DATA_INACTIVE: 'ORDER_MASTER_DATA_INACTIVE',
  DUPLICATE_PRODUCT: 'ORDER_DUPLICATE_PRODUCT',
  TOO_MANY_LINES: 'ORDER_TOO_MANY_LINES',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_REJECTED: 'UPSTREAM_REJECTED',
} as const;

export type OrderErrorReason =
  (typeof ORDER_ERROR_REASON)[keyof typeof ORDER_ERROR_REASON];

export class OrderDomainError extends DomainError {
  constructor(
    readonly reason: OrderErrorReason,
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message, { reason, ...details });
  }
}

const R = ORDER_ERROR_REASON;

export const OrderErrors = {
  notFound: (orderId: string) =>
    new OrderDomainError(
      R.NOT_FOUND,
      ErrorCode.ENTITY_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Không tìm thấy đơn hàng',
      { orderId },
    ),

  invalidTransition: (orderId: string, currentStatus: string, action: string) =>
    new OrderDomainError(
      R.INVALID_TRANSITION,
      ErrorCode.INVALID_STATE_TRANSITION,
      HttpStatus.CONFLICT,
      `Không thể thực hiện ${action} khi đơn hàng đang ở trạng thái ${currentStatus}`,
      { orderId, currentStatus, action },
    ),

  versionConflict: (
    orderId: string,
    expectedVersion: number,
    actualVersion: number,
  ) =>
    new OrderDomainError(
      R.VERSION_CONFLICT,
      ErrorCode.CONCURRENCY_CONFLICT,
      HttpStatus.CONFLICT,
      'Đơn hàng đã được người khác thay đổi, vui lòng tải lại',
      { orderId, expectedVersion, actualVersion },
    ),

  noChanges: () =>
    new OrderDomainError(
      R.NO_CHANGES,
      ErrorCode.VALIDATION_FAILED,
      HttpStatus.BAD_REQUEST,
      'Yêu cầu cập nhật không chứa thay đổi nào',
    ),

  invalidDateRange: () =>
    new OrderDomainError(
      R.INVALID_DATE_RANGE,
      ErrorCode.VALIDATION_FAILED,
      HttpStatus.BAD_REQUEST,
      'createdFrom phải nhỏ hơn hoặc bằng createdTo',
      { field: 'createdFrom' },
    ),

  addressNotOfCustomer: (deliveryAddressId: string, customerId: string) =>
    new OrderDomainError(
      R.ADDRESS_NOT_OF_CUSTOMER,
      ErrorCode.BUSINESS_RULE_VIOLATION,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Địa chỉ giao hàng không thuộc khách hàng đã chọn',
      { field: 'deliveryAddressId', deliveryAddressId, customerId },
    ),

  addressNotShipping: (deliveryAddressId: string) =>
    new OrderDomainError(
      R.ADDRESS_NOT_SHIPPING,
      ErrorCode.BUSINESS_RULE_VIOLATION,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Địa chỉ giao hàng phải là địa chỉ loại SHIPPING',
      { field: 'deliveryAddressId', deliveryAddressId },
    ),

  masterDataNotFound: (field: string, id: string) =>
    new OrderDomainError(
      R.MASTER_DATA_NOT_FOUND,
      ErrorCode.BUSINESS_RULE_VIOLATION,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Không tìm thấy dữ liệu danh mục cho ${field}`,
      { field, id },
    ),

  masterDataInactive: (field: string, id: string) =>
    new OrderDomainError(
      R.MASTER_DATA_INACTIVE,
      ErrorCode.BUSINESS_RULE_VIOLATION,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Dữ liệu danh mục cho ${field} đang ngừng hoạt động`,
      { field, id },
    ),

  duplicateProduct: (productId: string, field: string) =>
    new OrderDomainError(
      R.DUPLICATE_PRODUCT,
      ErrorCode.BUSINESS_RULE_VIOLATION,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Một sản phẩm chỉ được xuất hiện một lần trong đơn hàng',
      { field, productId },
    ),

  tooManyLines: (maxLines: number, actualLines: number) =>
    new OrderDomainError(
      R.TOO_MANY_LINES,
      ErrorCode.BUSINESS_RULE_VIOLATION,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Đơn hàng chỉ được có tối đa ${maxLines} dòng`,
      { field: 'lines', maxLines, actualLines },
    ),

  idempotencyKeyRequired: () =>
    new OrderDomainError(
      R.IDEMPOTENCY_KEY_REQUIRED,
      ErrorCode.VALIDATION_FAILED,
      HttpStatus.BAD_REQUEST,
      'Header Idempotency-Key bắt buộc và phải gồm 8-100 ký tự [A-Za-z0-9_.:-]',
    ),

  idempotencyKeyReused: () =>
    new OrderDomainError(
      R.IDEMPOTENCY_KEY_REUSED,
      ErrorCode.DUPLICATE_ENTITY,
      HttpStatus.CONFLICT,
      'Idempotency-Key đã được dùng cho một yêu cầu tạo đơn khác',
    ),

  upstreamUnavailable: (service: string) =>
    new OrderDomainError(
      R.UPSTREAM_UNAVAILABLE,
      ErrorCode.SERVICE_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      'Dịch vụ phụ thuộc tạm thời không phản hồi, vui lòng thử lại sau',
      { service },
    ),

  upstreamRejected: (service: string, upstreamStatus: number) =>
    new OrderDomainError(
      R.UPSTREAM_REJECTED,
      ErrorCode.DOWNSTREAM_ERROR,
      HttpStatus.BAD_GATEWAY,
      'Dịch vụ phụ thuộc từ chối yêu cầu',
      { service, upstreamStatus },
    ),
} as const;
