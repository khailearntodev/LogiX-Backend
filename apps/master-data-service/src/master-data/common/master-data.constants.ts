export const RecordStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;

export type RecordStatus = (typeof RecordStatus)[keyof typeof RecordStatus];

/** SHIPPING = ship-to (delivery), BILLING = bill-to (invoice/legal address). */
export const CustomerAddressType = {
  SHIPPING: 'SHIPPING',
  BILLING: 'BILLING',
} as const;

export type CustomerAddressType =
  (typeof CustomerAddressType)[keyof typeof CustomerAddressType];

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
