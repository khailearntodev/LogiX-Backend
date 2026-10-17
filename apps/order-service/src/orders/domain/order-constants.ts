import { ORDER_STATUS, type OrderStatus } from './order-status.js';

/** Orders are keyed in by staff in the MVP; channel imports are a stretch goal. */
export const ORDER_SOURCE = {
  MANUAL: 'MANUAL',
} as const;

export const ORDER_NUMBER_PREFIX = 'SO';
export const ORDER_NUMBER_SEQUENCE_DIGITS = 6;
/** Business day boundary used for the YYYYMMDD part of order numbers. */
export const ORDER_BUSINESS_TIMEZONE = 'Asia/Ho_Chi_Minh';

export const SALES_ORDER_AGGREGATE = 'SalesOrder';
export const ORDER_EVENT_VERSION = 1;
export const ORDER_EVENT = {
  CREATED: 'OrderCreated',
  UPDATED: 'OrderUpdated',
  CANCELED: 'OrderCanceled',
  CONFIRMED: 'OrderConfirmed',
  PENDING_STOCK: 'OrderPendingStock',
} as const;

export type OrderEventType = (typeof ORDER_EVENT)[keyof typeof ORDER_EVENT];

/** Statuses whose header and lines may still be edited. */
export const ORDER_EDITABLE_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.PENDING_STOCK,
];

/** Cancellation of later statuses is opened together with reservation/fulfillment phases. */
export const ORDER_CANCELABLE_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.PENDING_STOCK,
  ORDER_STATUS.CONFIRMED,
];

export const MASTER_DATA_REQUEST_TIMEOUT_MS = 5_000;
export const MASTER_DATA_SERVICE_NAME = 'master-data-service';
/** Upper bound of parallel product lookups per order request. */
export const MASTER_DATA_MAX_CONCURRENT_REQUESTS = 10;

export const ORDER_DEFAULT_PAGE_SIZE = 20;
export const ORDER_MAX_PAGE_SIZE = 100;
export const ORDER_NUMBER_SEARCH_MAX_LENGTH = 50;
export const ORDER_CANCEL_REASON_MAX_LENGTH = 500;

/** Positive decimal with up to 15 integer and 3 fractional digits, matching numeric(18,3). */
export const ORDER_QUANTITY_PATTERN =
  /^(?!0+(?:\.0+)?$)\d{1,15}(?:\.\d{1,3})?$/;
export const ORDER_CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export const MASTER_DATA_RECORD_STATUS_ACTIVE = 'ACTIVE';
export const DELIVERY_ADDRESS_TYPE = 'SHIPPING';
