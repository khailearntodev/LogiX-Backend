import type { Prisma } from '../../generated/prisma/client.js';
import type {
  CustomerAddressView,
  CustomerView,
  ProductView,
  VehicleView,
  WarehouseView,
} from './master-data.types.js';

type Decimal = Prisma.Decimal;

function coord(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed(6);
}

export function toWarehouseView(row: {
  id: string;
  code: string;
  name: string;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: Decimal | null;
  longitude: Decimal | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): WarehouseView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    addressLine: row.addressLine,
    ward: row.ward,
    district: row.district,
    province: row.province,
    postalCode: row.postalCode,
    latitude: coord(row.latitude),
    longitude: coord(row.longitude),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProductView(row: {
  id: string;
  sku: string;
  name: string;
  baseUnit: string;
  weight: Decimal;
  volume: Decimal;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): ProductView {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    baseUnit: row.baseUnit,
    weight: row.weight.toFixed(3),
    volume: row.volume.toFixed(6),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVehicleView(row: {
  id: string;
  code: string;
  licensePlate: string;
  capacityWeight: Decimal;
  capacityVolume: Decimal;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): VehicleView {
  return {
    id: row.id,
    code: row.code,
    licensePlate: row.licensePlate,
    capacityWeight: row.capacityWeight.toFixed(3),
    capacityVolume: row.capacityVolume.toFixed(6),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCustomerView(row: {
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
}): CustomerView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    taxCode: row.taxCode,
    phone: row.phone,
    email: row.email,
    status: row.status,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCustomerAddressView(row: {
  id: string;
  customerId: string;
  label: string | null;
  recipientName: string;
  phone: string | null;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: Decimal | null;
  longitude: Decimal | null;
  isDefault: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): CustomerAddressView {
  return {
    id: row.id,
    customerId: row.customerId,
    label: row.label,
    recipientName: row.recipientName,
    phone: row.phone,
    addressLine: row.addressLine,
    ward: row.ward,
    district: row.district,
    province: row.province,
    postalCode: row.postalCode,
    latitude: coord(row.latitude),
    longitude: coord(row.longitude),
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
