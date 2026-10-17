/**
 * Read models consumed from master-data-service (`/api/v1`). Only the fields the
 * order domain relies on are declared; the upstream contract may carry more.
 */
export interface MasterDataCustomer {
  id: string;
  code: string;
  name: string;
  taxCode: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  version: number;
}

export interface MasterDataCustomerAddress {
  id: string;
  customerId: string;
  addressType: string;
  label: string | null;
  recipientName: string;
  phone: string | null;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  deliveryNote: string | null;
  status: string;
  version: number;
}

export interface MasterDataWarehouse {
  id: string;
  code: string;
  name: string;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  status: string;
  version: number;
}

/** `weight` and `volume` are decimal strings (Decimal(18,3) / Decimal(18,6)). */
export interface MasterDataProduct {
  id: string;
  sku: string;
  name: string;
  baseUnit: string;
  weight: string;
  volume: string;
  status: string;
  version: number;
}

/** Caller credentials forwarded to Master Data so tenant scoping stays upstream. */
export interface MasterDataRequestContext {
  authorization: string;
  correlationId: string;
}
