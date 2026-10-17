export interface ReservationLine {
  orderLineId: string;
  productId: string;
  quantity: string;
}

export interface ReserveRequest {
  orderId: string;
  orderVersion: number;
  warehouseId: string;
  lines: ReservationLine[];
}

export interface ReservationShortage {
  productId: string;
  required: string;
  available: string;
}

export type ReserveResult =
  | { outcome: 'RESERVED'; reservationGroupId: string }
  | { outcome: 'INSUFFICIENT'; shortages: ReservationShortage[] };

export interface ReservationPreview {
  checkedAt: string;
  lines: Array<ReservationShortage & { sufficient: boolean }>;
}
