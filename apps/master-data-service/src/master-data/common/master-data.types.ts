export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface GeoPoint {
  latitude: string | null;
  longitude: string | null;
}

export interface WarehouseView extends GeoPoint {
  id: string;
  code: string;
  name: string;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** `weight` and `volume` are strings so Decimal(18,3) / Decimal(18,6) survive JSON. */
export interface ProductView {
  id: string;
  sku: string;
  name: string;
  baseUnit: string;
  weight: string;
  volume: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VehicleView {
  id: string;
  code: string;
  licensePlate: string;
  capacityWeight: string;
  capacityVolume: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerView {
  id: string;
  code: string;
  name: string;
  taxCode: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerAddressView extends GeoPoint {
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
  deliveryNote: string | null;
  isDefault: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
